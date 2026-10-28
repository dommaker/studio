/**
 * 认证状态管理 - Auth Store (Zustand)
 * SEC-001: 用户认证系统
 * 使用 zustand persist 中间件自动持久化
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthSession, AuthUser } from '@dommaker/studio-contract';
import { authApi } from '../api';
import { serverErrorMessage } from '../utils/errorMessage';

export type User = Pick<AuthUser, 'id' | 'email'> & Partial<Pick<AuthUser, 'createdAt'>> & {
  name?: string;
  avatar?: string;
  role: 'Guest' | 'User' | 'Admin';
};

export type Session = Pick<AuthSession, 'id' | 'expiresAt'>;

function normalizeRole(role: string): User['role'] {
  if (role === 'Guest' || role === 'User' || role === 'Admin') return role;
  return 'Guest';
}

function normalizeUser(user: AuthUser): User {
  return {
    id: user.id,
    email: user.email,
    role: normalizeRole(user.role),
    ...(user.name !== null ? { name: user.name } : {}),
    ...(user.avatar !== null ? { avatar: user.avatar } : {}),
    createdAt: user.createdAt,
  };
}

function normalizeSession(session: AuthSession): Session {
  return { id: session.id, expiresAt: session.expiresAt };
}

interface AuthState {
  token: string | null;
  user: User | null;
  session: Session | null;
  refreshToken: string | null;
  guestId: string | null;
  isLoading: boolean;
  error: string | null;

  // Computed
  isAuthenticated: () => boolean;
  isAdmin: () => boolean;
  isGuest: () => boolean;
  getRole: () => string;

  // Actions
  init: () => Promise<void>;
  createGuestSession: () => Promise<void>;
  checkAuth: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  register: (email: string, password: string, name?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  fetchMe: () => Promise<void>;
  getAuthHeader: () => Record<string, string>;
  setToken: (token: string, refreshToken?: string) => void;
  setError: (error: string | null) => void;
}

function generateGuestId(): string {
  return `guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      // State
      token: null,
      user: null,
      session: null,
      refreshToken: null,
      guestId: null,
      isLoading: false,
      error: null,

      // Computed
      isAuthenticated: () => !!get().user && get().user!.role !== 'Guest',
      isAdmin: () => get().user?.role === 'Admin',
      isGuest: () => !get().user || get().user!.role === 'Guest',
      getRole: () => get().user?.role || 'Guest',

      // Actions
      init: async () => {
        if (get().token) {
          await get().checkAuth();
        } else {
          await get().createGuestSession();
        }
      },

      createGuestSession: async () => {
        set({ isLoading: true, error: null });
        try {
          const guestId = get().guestId || generateGuestId();
          // { data } 壳（契约驱动批次 6/7）；nullable/role 在 store 边界归一
          const data = (await authApi.createGuestSession(guestId)).data.data;

          set({
            token: data.token,
            session: normalizeSession(data.session),
            user: data.user ? normalizeUser(data.user) : { id: guestId, email: '', role: 'Guest' },
            guestId,
            isLoading: false,
          });
        } catch (e) {
          set({ error: serverErrorMessage(e) || (e instanceof Error ? e.message : undefined) || '创建 Session 失败', isLoading: false });
        }
      },

      checkAuth: async () => {
        const token = get().token;
        if (!token) return;

        set({ isLoading: true, error: null });
        try {
          const data = (await authApi.checkAuth()).data.data;

          if (data.user) {
            set({ user: normalizeUser(data.user), isLoading: false });
          } else {
            set({ isLoading: false });
            await get().createGuestSession();
          }
        } catch (e) {
          set({ error: serverErrorMessage(e) || (e instanceof Error ? e.message : null), isLoading: false });
          await get().createGuestSession();
        }
      },

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          // { data } 壳（契约驱动批次 6/7）；失败恒走 4xx 拒绝（原 200+{error} 分支退役）
          const data = (await authApi.login(email, password)).data.data;

          set({
            token: data.token,
            refreshToken: data.refreshToken || null,
            user: data.user ? normalizeUser(data.user) : null,
            session: normalizeSession(data.session),
            isLoading: false,
          });
          return true;
        } catch (e) {
          set({ error: serverErrorMessage(e) || (e instanceof Error ? e.message : undefined) || '登录失败', isLoading: false });
          return false;
        }
      },

      register: async (email: string, password: string, name?: string) => {
        set({ isLoading: true, error: null });
        try {
          const data = (await authApi.register(email, password, name)).data.data;

          set({
            token: data.token,
            refreshToken: data.refreshToken || null,
            user: data.user ? normalizeUser(data.user) : null,
            session: normalizeSession(data.session),
            isLoading: false,
          });
          return true;
        } catch (e) {
          set({ error: serverErrorMessage(e) || (e instanceof Error ? e.message : undefined) || '注册失败', isLoading: false });
          return false;
        }
      },

      logout: async () => {
        try {
          await authApi.logout();
        } catch (e) {
          console.error('Logout error:', e);
        }

        set({ token: null, user: null, session: null });
        await get().createGuestSession();
      },

      fetchMe: async () => {
        try {
          const data = (await authApi.fetchMe()).data.data;
          if (data.user) {
            set({
              user: normalizeUser(data.user),
              session: data.session ? normalizeSession(data.session) : null,
            });
          }
        } catch (e) {
          console.error('Fetch me error:', e);
        }
      },

      getAuthHeader: (): Record<string, string> => {
        const token = get().token;
        if (!token) return {};
        return { Authorization: `Bearer ${token}` };
      },

      setToken: (token: string, refreshToken?: string) =>
        set({ token, ...(refreshToken ? { refreshToken } : {}) }),

      setError: (error: string | null) => set({ error }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        token: state.token,
        refreshToken: state.refreshToken,
        user: state.user,
        session: state.session,
        guestId: state.guestId,
      }),
    }
  )
);
