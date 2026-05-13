const { pool } = require('../config/database');
const { getNegotiationSession, deleteNegotiationSession } = require('../config/redis');
const notificationService = require('../services/notification.service');
const { getIO } = require('../socket');
const logger = require('../utils/logger');

const MAX_COUNTER_OFFERS = parseInt(process.env.MAX_COUNTER_OFFERS) || 3;

// ── GET /api/negotiations/:jobId ──────────────────────────────────────────
async function getNegotiation(req, res) {
  const { jobId } = req.params;
  try {
    const { rows: [neg] } = await pool.query(
      `SELECT n.*, j.description, j.photo_urls, j.category_id,
              j.client_id, j.handyman_id, j.client_address,
              sc.name as category_name
       FROM negotiations n
       JOIN jobs j ON j.id = n.job_id
       JOIN service_categories sc ON sc.id = j.category_id
       WHERE n.job_id = $1`, [jobId]
    );
    if (!neg) return res.status(404).json({ success: false, message: 'Negotiation not found' });

    // Get messages
    const { rows: messages } = await pool.query(
      `SELECT nm.*, u.first_name || ' ' || u.last_name as sender_name
       FROM negotiation_messages nm
       JOIN users u ON u.id = nm.sender_id
       WHERE nm.negotiation_id = $1
       ORDER BY nm.sent_at ASC`,
      [neg.id]
    );

    // Get latest quote card
    const { rows: [quote] } = await pool.query(
      `SELECT * FROM quote_cards WHERE negotiation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [neg.id]
    );

    // Get market rate (handyman only — DO NOT send to client)
    let marketRate = null;
    if (req.user.role === 'handyman') {
      const { rows: [rate] } = await pool.query(
        `SELECT min_rate_cad, max_rate_cad FROM market_rates WHERE category_id = $1 LIMIT 1`,
        [neg.category_id]
      );
      marketRate = rate;
    }

    res.json({ success: true, negotiation: neg, messages, latestQuote: quote || null, marketRate });
  } catch (err) {
    logger.error('getNegotiation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch negotiation' });
  }
}

// ── POST /api/negotiations/:jobId/messages — Send a chat message ──────────
async function sendMessage(req, res) {
  const { jobId } = req.params;
  const { content, messageType = 'text', photoUrl } = req.body;
  const senderId = req.user.id;

  // Block contact info sharing
  const contactPattern = /(\+?1?\s?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|(@[a-zA-Z0-9_]+)/g;
  if (contactPattern.test(content)) {
    return res.status(400).json({
      success: false,
      message: 'Sharing contact details is not allowed in the negotiation chat. All communication must stay on-platform.',
      blocked: true
    });
  }

  try {
    const { rows: [neg] } = await pool.query(
      `SELECT n.*, j.client_id, j.handyman_id FROM negotiations n
       JOIN jobs j ON j.id = n.job_id WHERE n.job_id = $1 AND n.status = 'open'`, [jobId]
    );
    if (!neg) return res.status(404).json({ success: false, message: 'Negotiation not open' });

    const { rows: [msg] } = await pool.query(
      `INSERT INTO negotiation_messages (negotiation_id, sender_id, message_type, content, photo_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [neg.id, senderId, messageType, content, photoUrl || null]
    );

    // Broadcast via socket to both parties
    const io = getIO();
    io.to(`job:${jobId}`).emit('negotiation:message', {
      ...msg, senderName: `${req.user.first_name} ${req.user.last_name}`
    });

    // Push notification to other party
    const recipientId = senderId === neg.client_id ? neg.handyman_id : neg.client_id;
    await notificationService.sendToUser(recipientId, {
      title: `New message from ${req.user.first_name}`,
      body: content.substring(0, 100),
      type: 'negotiation_message',
      data: { jobId }
    });

    res.status(201).json({ success: true, message: msg });
  } catch (err) {
    logger.error('sendMessage error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
}

// ── POST /api/negotiations/:jobId/quote — Handyman sends a quote card ─────
async function sendQuote(req, res) {
  const { jobId } = req.params;
  const { quotedPrice, estimatedDuration } = req.body;
  const handymanId = req.user.id;
  const db = await pool.connect();

  try {
    await db.query('BEGIN');

    const { rows: [neg] } = await db.query(
      `SELECT n.*, j.client_id, j.handyman_id, hp.commission_rate
       FROM negotiations n
       JOIN jobs j ON j.id = n.job_id
       JOIN handyman_profiles hp ON hp.user_id = j.handyman_id
       WHERE n.job_id = $1 AND n.status = 'open' AND j.handyman_id = $2`,
      [jobId, handymanId]
    );
    if (!neg) return res.status(404).json({ success: false, message: 'Negotiation not found or not authorised' });

    const commissionRate = parseFloat(neg.commission_rate);
    const netEarnings = parseFloat((quotedPrice * (1 - commissionRate)).toFixed(2));

    // Expire any previous pending quote
    await db.query(
      `UPDATE quote_cards SET status = 'declined' WHERE negotiation_id = $1 AND status = 'pending'`,
      [neg.id]
    );

    const { rows: [quote] } = await db.query(
      `INSERT INTO quote_cards
         (negotiation_id, handyman_id, quoted_price, estimated_duration, net_earnings_preview, commission_rate)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [neg.id, handymanId, quotedPrice, estimatedDuration, netEarnings, commissionRate]
    );

    // Post quote card as a special message in the chat
    await db.query(
      `INSERT INTO negotiation_messages
         (negotiation_id, sender_id, message_type, metadata)
       VALUES ($1, $2, 'quote_card', $3)`,
      [neg.id, handymanId, JSON.stringify({ quoteId: quote.id, quotedPrice, estimatedDuration, netEarnings })]
    );

    await db.query('COMMIT');

    // Broadcast to job room
    const io = getIO();
    io.to(`job:${jobId}`).emit('negotiation:quote', quote);

    // Notify client
    await notificationService.sendToUser(neg.client_id, {
      title: '💰 You have a quote!',
      body: `Your handyman quoted $${quotedPrice} for the job. Tap to respond.`,
      type: 'quote_received',
      data: { jobId, quoteId: quote.id, quotedPrice }
    });

    res.status(201).json({ success: true, quote });
  } catch (err) {
    await db.query('ROLLBACK');
    logger.error('sendQuote error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send quote' });
  } finally {
    db.release();
  }
}

// ── POST /api/negotiations/:jobId/quote/:quoteId/respond ──────────────────
async function respondToQuote(req, res) {
  const { jobId, quoteId } = req.params;
  const { action, counterPrice } = req.body; // action: 'accept' | 'decline' | 'counter'
  const clientId = req.user.id;
  const db = await pool.connect();

  try {
    await db.query('BEGIN');

    const { rows: [quote] } = await db.query(
      `SELECT qc.*, n.id as neg_id, n.counter_count, j.handyman_id, n.client_id
       FROM quote_cards qc
       JOIN negotiations n ON n.id = qc.negotiation_id
       JOIN jobs j ON j.id = n.job_id
       WHERE qc.id = $1 AND n.job_id = $2 AND qc.status = 'pending'`,
      [quoteId, jobId]
    );
    if (!quote) return res.status(404).json({ success: false, message: 'Quote not found or already responded' });

    const io = getIO();

    if (action === 'accept') {
      // Lock the price — update job and negotiation
      await db.query(
        `UPDATE quote_cards SET status = 'accepted', responded_at = NOW() WHERE id = $1`, [quoteId]
      );
      await db.query(
        `UPDATE negotiations SET status = 'agreed', updated_at = NOW() WHERE id = $1`, [quote.neg_id]
      );
      await db.query(
        `UPDATE jobs SET
           status = 'agreed', agreed_price = $1, commission_rate = $2,
           commission_amount = $3, net_earnings = $4, agreed_at = NOW(), updated_at = NOW()
         WHERE id = $5`,
        [
          quote.quoted_price,
          quote.commission_rate,
          parseFloat((quote.quoted_price * quote.commission_rate).toFixed(2)),
          quote.net_earnings_preview,
          jobId
        ]
      );

      await db.query('COMMIT');
      await deleteNegotiationSession(quote.neg_id);

      io.to(`job:${jobId}`).emit('negotiation:agreed', {
        jobId, agreedPrice: quote.quoted_price, netEarnings: quote.net_earnings_preview
      });

      await notificationService.sendToUser(quote.handyman_id, {
        title: '✅ Quote accepted!',
        body: `Your quote of $${quote.quoted_price} was accepted. Head to the client!`,
        type: 'quote_accepted',
        data: { jobId, agreedPrice: quote.quoted_price }
      });

      return res.json({ success: true, action: 'accepted', agreedPrice: quote.quoted_price });

    } else if (action === 'decline') {
      await db.query(
        `UPDATE quote_cards SET status = 'declined', responded_at = NOW() WHERE id = $1`, [quoteId]
      );
      await db.query('COMMIT');
      io.to(`job:${jobId}`).emit('negotiation:quote_declined', { jobId });
      return res.json({ success: true, action: 'declined' });

    } else if (action === 'counter') {
      if (!counterPrice) return res.status(400).json({ success: false, message: 'counterPrice required' });
      if (quote.counter_count >= MAX_COUNTER_OFFERS)
        return res.status(400).json({ success: false, message: `Maximum ${MAX_COUNTER_OFFERS} counter-offers reached` });

      await db.query(
        `UPDATE quote_cards SET status = 'countered', responded_at = NOW(), counter_count = counter_count + 1 WHERE id = $1`, [quoteId]
      );
      const { rows: [counter] } = await db.query(
        `INSERT INTO counter_offers (quote_id, client_id, proposed_price) VALUES ($1, $2, $3) RETURNING *`,
        [quoteId, clientId, counterPrice]
      );
      await db.query(
        `UPDATE negotiations SET counter_count = counter_count + 1, updated_at = NOW() WHERE id = $1`, [quote.neg_id]
      );

      await db.query(
        `INSERT INTO negotiation_messages (negotiation_id, sender_id, message_type, metadata)
         VALUES ($1, $2, 'counter_offer', $3)`,
        [quote.neg_id, clientId, JSON.stringify({ counterId: counter.id, proposedPrice: counterPrice })]
      );

      await db.query('COMMIT');

      io.to(`job:${jobId}`).emit('negotiation:counter', { counter, jobId });
      await notificationService.sendToUser(quote.handyman_id, {
        title: '💬 Counter-offer received',
        body: `The client is offering $${counterPrice}. Tap to respond.`,
        type: 'counter_offer',
        data: { jobId, counterId: counter.id, proposedPrice: counterPrice }
      });

      return res.json({ success: true, action: 'countered', counter });
    }

    res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (err) {
    await db.query('ROLLBACK');
    logger.error('respondToQuote error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to respond to quote' });
  } finally {
    db.release();
  }
}

module.exports = { getNegotiation, sendMessage, sendQuote, respondToQuote };
