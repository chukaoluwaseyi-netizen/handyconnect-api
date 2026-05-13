import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { authAPI } from '../services/api.service';

// ── Auth Store ─────────────────────────────────────────────────────────────
export const useAuthStore = create((set, get) => ({
  user: null,
  profile: null,
  token: null,
  isLoading: true,

  init: async () => {
    const token = await SecureStore.getItemAsync('auth_token');
    if (token) {
      try {
        const { data } = await authAPI.getMe();
        set({ user: data.user, profile: data.profile, token, isLoading: false });
      } catch {
        await SecureStore.deleteItemAsync('auth_token');
        set({ isLoading: false });
      }
    } else {
      set({ isLoading: false });
    }
  },

  login: async (email, password) => {
    const { data } = await authAPI.login({ email, password });
    await SecureStore.setItemAsync('auth_token', data.token);
    set({ user: data.user, profile: data.profile, token: data.token });
    return data.user;
  },

  logout: async () => {
    await SecureStore.deleteItemAsync('auth_token');
    set({ user: null, profile: null, token: null });
  },

  updateProfile: (profile) => set({ profile }),
}));

// ── Job Store ──────────────────────────────────────────────────────────────
export const useJobStore = create((set) => ({
  activeJob: null,
  jobs: [],
  isLoading: false,

  setActiveJob: (job) => set({ activeJob: job }),
  setJobs: (jobs) => set({ jobs }),
  updateJobStatus: (jobId, status, extra = {}) =>
    set((state) => ({
      activeJob: state.activeJob?.id === jobId
        ? { ...state.activeJob, status, ...extra }
        : state.activeJob,
      jobs: state.jobs.map((j) => (j.id === jobId ? { ...j, status, ...extra } : j)),
    })),
  clearActiveJob: () => set({ activeJob: null }),
}));

// ── Negotiation Store ─────────────────────────────────────────────────────
export const useNegotiationStore = create((set) => ({
  negotiation: null,
  messages: [],
  latestQuote: null,
  marketRate: null,
  timeRemaining: 0,

  setNegotiation: (negotiation) => set({ negotiation }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  setLatestQuote: (quote) => set({ latestQuote: quote }),
  setMarketRate: (marketRate) => set({ marketRate }),
  setTimeRemaining: (timeRemaining) => set({ timeRemaining }),
  clearNegotiation: () =>
    set({ negotiation: null, messages: [], latestQuote: null, marketRate: null }),
}));

// ── Handyman Availability Store ────────────────────────────────────────────
export const useHandymanStore = create((set) => ({
  isOnline: false,
  currentLocation: null,
  pendingJob: null,

  setOnline: (isOnline) => set({ isOnline }),
  setLocation: (location) => set({ currentLocation: location }),
  setPendingJob: (job) => set({ pendingJob: job }),
  clearPendingJob: () => set({ pendingJob: null }),
}));
