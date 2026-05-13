const { pool } = require('../config/database');
const { setNegotiationSession } = require('../config/redis');
const notificationService = require('./notification.service');
const logger = require('../utils/logger');

const NEGOTIATION_WINDOW = parseInt(process.env.NEGOTIATION_WINDOW_SECONDS) || 600;

/**
 * Haversine distance in km between two lat/lng pairs
 */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Find available handymen for a job and initiate negotiation with the best match.
 * Matching criteria:
 *   1. Service category match
 *   2. Within service radius
 *   3. Online + approved + background checked
 *   4. Rank by: rating (desc), proximity (asc), subscription tier (elite > pro > basic)
 */
async function findMatch(job, clientLat, clientLng, excludeHandymanIds = []) {
  logger.info(`Matching job ${job.id} | category: ${job.category_id} | location: ${clientLat},${clientLng}`);

  // Get category slug
  const { rows: [cat] } = await pool.query(
    'SELECT slug FROM service_categories WHERE id = $1', [job.category_id]
  );
  if (!cat) { logger.warn(`No category found for job ${job.id}`); return; }

  // Find available handymen with the required category
  const { rows: candidates } = await pool.query(
    `SELECT
       hp.user_id, hp.location_lat, hp.location_lng,
       hp.rating_avg, hp.service_radius_km, hp.commission_rate,
       hp.subscription_tier,
       u.first_name || ' ' || u.last_name as name,
       u.profile_photo
     FROM handyman_profiles hp
     JOIN users u ON u.id = hp.user_id
     WHERE hp.is_online = true
       AND hp.is_approved = true
       AND hp.is_background_checked = true
       AND $1 = ANY(hp.service_categories)
       AND hp.location_lat IS NOT NULL
       AND hp.location_lng IS NOT NULL
       ${excludeHandymanIds.length ? `AND hp.user_id != ALL($2::uuid[])` : ''}
    `,
    excludeHandymanIds.length
      ? [cat.slug, excludeHandymanIds]
      : [cat.slug]
  );

  if (!candidates.length) {
    logger.info(`No available handymen for job ${job.id}`);
    await updateJobStatus(job.id, 'requested'); // stay requested — notify client
    await notificationService.sendToUser(job.client_id, {
      title: 'No handymen available right now',
      body: 'We\'ll keep searching. You can also schedule for later.',
      type: 'no_match',
      data: { jobId: job.id }
    });
    return;
  }

  // Score and rank candidates
  const tierScore = { elite: 3, pro: 2, basic: 1 };
  const ranked = candidates
    .map(h => {
      const distance = haversine(clientLat, clientLng, h.location_lat, h.location_lng);
      if (distance > h.service_radius_km) return null; // outside radius
      const score =
        (parseFloat(h.rating_avg) * 20) +           // rating: up to 100 pts
        Math.max(0, 50 - distance * 2) +             // proximity: up to 50 pts
        (tierScore[h.subscription_tier] || 1) * 5;  // tier: up to 15 pts
      return { ...h, distance: distance.toFixed(2), score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    logger.info(`No handymen within radius for job ${job.id}`);
    return;
  }

  const bestMatch = ranked[0];
  logger.info(`Matched job ${job.id} → handyman ${bestMatch.user_id} (score: ${bestMatch.score.toFixed(1)}, dist: ${bestMatch.distance}km)`);

  // Update job: assign handyman, open negotiation
  await pool.query(
    `UPDATE jobs SET handyman_id = $1, status = 'negotiating', negotiation_started_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [bestMatch.user_id, job.id]
  );

  // Create negotiation record
  const expiresAt = new Date(Date.now() + NEGOTIATION_WINDOW * 1000);
  const { rows: [neg] } = await pool.query(
    `INSERT INTO negotiations (job_id, status, expires_at)
     VALUES ($1, 'open', $2) RETURNING *`,
    [job.id, expiresAt]
  );

  // Cache in Redis for real-time countdown
  await setNegotiationSession(neg.id, {
    jobId: job.id, handymanId: bestMatch.user_id, clientId: job.client_id,
    expiresAt: expiresAt.toISOString(), excludedHandymen: excludeHandymanIds
  }, NEGOTIATION_WINDOW);

  // Get market rate for the handyman's info
  const { rows: [rate] } = await pool.query(
    `SELECT min_rate_cad, max_rate_cad FROM market_rates
     WHERE category_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [job.category_id]
  );

  // Notify handyman via push
  await notificationService.sendToUser(bestMatch.user_id, {
    title: '🔔 New job request!',
    body: `${job.description.substring(0, 80)}... — ${bestMatch.distance}km away`,
    type: 'new_job_negotiation',
    data: {
      jobId: job.id,
      negotiationId: neg.id,
      categoryId: job.category_id,
      description: job.description,
      photoUrls: job.photo_urls,
      clientAddress: job.client_address,
      distanceKm: bestMatch.distance,
      commissionRate: bestMatch.commission_rate,
      marketRate: rate ? { min: rate.min_rate_cad, max: rate.max_rate_cad } : null,
      expiresAt: expiresAt.toISOString(),
      windowSeconds: NEGOTIATION_WINDOW
    }
  });

  // Notify client
  await notificationService.sendToUser(job.client_id, {
    title: 'Handyman found!',
    body: `${bestMatch.name} is reviewing your job. Negotiation chat is open.`,
    type: 'negotiation_opened',
    data: { jobId: job.id, negotiationId: neg.id, handymanId: bestMatch.user_id }
  });

  // Schedule expiry check
  scheduleNegotiationExpiry(neg.id, job, excludeHandymanIds, bestMatch.user_id, NEGOTIATION_WINDOW);
}

/**
 * After the window expires with no agreement, try the next handyman.
 */
function scheduleNegotiationExpiry(negotiationId, job, prevExcluded, currentHandymanId, windowSec) {
  setTimeout(async () => {
    const { rows: [neg] } = await pool.query(
      'SELECT status FROM negotiations WHERE id = $1', [negotiationId]
    );
    if (!neg || neg.status !== 'open') return; // already resolved

    logger.info(`Negotiation ${negotiationId} expired — trying next handyman`);
    await pool.query(
      `UPDATE negotiations SET status = 'expired', updated_at = NOW() WHERE id = $1`,
      [negotiationId]
    );
    await pool.query(
      `UPDATE jobs SET handyman_id = NULL, status = 'requested', updated_at = NOW() WHERE id = $1`,
      [job.id]
    );

    // Try next handyman, excluding this one
    const newExcluded = [...prevExcluded, currentHandymanId];
    const { rows: [freshJob] } = await pool.query('SELECT * FROM jobs WHERE id = $1', [job.id]);
    await findMatch(freshJob, freshJob.client_lat, freshJob.client_lng, newExcluded);
  }, windowSec * 1000);
}

async function updateJobStatus(jobId, status) {
  await pool.query('UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2', [status, jobId]);
}

module.exports = { findMatch };
