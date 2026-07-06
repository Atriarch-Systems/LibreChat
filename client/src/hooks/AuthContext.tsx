import {
  useRef,
  useMemo,
  useState,
  useEffect,
  useContext,
  useCallback,
  createContext,
} from 'react';
import { debounce } from 'lodash';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { useNavigate } from 'react-router-dom';
import {
  request,
  apiBaseUrl,
  SystemRoles,
  setTokenHeader,
  isSystemRoleName,
  buildLoginRedirectUrl,
} from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  useGetRole,
  useGetUserQuery,
  useLoginUserMutation,
  useLogoutUserMutation,
  useRefreshTokenMutation,
} from '~/data-provider';
import { TAuthConfig, TUserContext, TAuthContext, TResError } from '~/common';
import { SESSION_KEY, isSafeRedirect, getPostLoginRedirect } from '~/utils';
import useTimeout from './useTimeout';
import store from '~/store';

const AuthContext = (import.meta.hot?.data?.__AuthContext ??
  createContext<TAuthContext | undefined>(undefined)) as React.Context<TAuthContext | undefined>;
if (import.meta.hot) {
  import.meta.hot.data.__AuthContext = AuthContext;
}

/**
 * Refresh resilience (Atriarch): a single transient failure to refresh the OIDC token must not
 * log the user out. Network errors (no HTTP response) and 5xx responses — including the server's
 * 503 when the IdP is briefly unreachable, e.g. during a deploy — are retryable; only a genuine
 * rejection (4xx, e.g. an invalid_grant surfaced as 403) means the user must re-authenticate.
 */
const MAX_REFRESH_RETRIES = 3;
const REFRESH_RETRY_DELAYS_MS = [2000, 5000, 15000];

const isTransientAuthError = (error: unknown): boolean => {
  const err = error as { response?: { status?: number }; status?: number } | undefined;
  const status = err?.response?.status ?? err?.status;
  if (typeof status !== 'number') {
    return true;
  }
  return status >= 500;
};

const AuthContextProvider = ({
  authConfig,
  children,
}: {
  authConfig?: TAuthConfig;
  children: ReactNode;
}) => {
  const isExternalRedirectRef = useRef(false);
  const refreshRetryRef = useRef(0);
  const [user, setUser] = useRecoilState(store.user);
  const logoutRedirectRef = useRef<string | undefined>(undefined);
  const [token, setToken] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const setQueriesEnabled = useSetRecoilState<boolean>(store.queriesEnabled);

  const userRoleName = user?.role ?? '';
  const isCustomRole = isAuthenticated && !!user?.role && !isSystemRoleName(user.role);

  const { data: userRole = null } = useGetRole(SystemRoles.USER, {
    enabled: !!(isAuthenticated && (user?.role ?? '')),
  });
  const { data: adminRole = null } = useGetRole(SystemRoles.ADMIN, {
    enabled: !!(isAuthenticated && user?.role === SystemRoles.ADMIN),
  });
  const { data: customRole = null } = useGetRole(isCustomRole ? userRoleName : '_', {
    enabled: isCustomRole,
  });

  const navigate = useNavigate();

  const setUserContext = useMemo(
    () =>
      debounce((userContext: TUserContext) => {
        const { token, isAuthenticated, user, redirect } = userContext;
        setUser(user);
        setToken(token);
        setTokenHeader(token);
        setIsAuthenticated(isAuthenticated);
        if (isAuthenticated) {
          setQueriesEnabled(true);
        }

        const searchParams = new URLSearchParams(window.location.search);
        const postLoginRedirect = getPostLoginRedirect(searchParams);

        const logoutRedirect = logoutRedirectRef.current;
        logoutRedirectRef.current = undefined;

        const finalRedirect =
          logoutRedirect ??
          postLoginRedirect ??
          (redirect && isSafeRedirect(redirect) ? redirect : null);

        if (finalRedirect == null) {
          return;
        }

        navigate(finalRedirect, { replace: true });
      }, 50),
    [navigate, setUser, setQueriesEnabled],
  );
  const doSetError = useTimeout({ callback: (error) => setError(error as string | undefined) });

  const loginUser = useLoginUserMutation({
    onSuccess: (data: t.TLoginResponse) => {
      const { user, token, twoFAPending, tempToken } = data;
      if (twoFAPending) {
        navigate(`/login/2fa?tempToken=${tempToken}`, { replace: true });
        return;
      }
      setError(undefined);
      setUserContext({ token, isAuthenticated: true, user, redirect: '/c/new' });
    },
    onError: (error: TResError | unknown) => {
      const resError = error as TResError;
      doSetError(resError.message);
      // Preserve a valid redirect_to across login failures so the deep link survives retries.
      // Cannot use buildLoginRedirectUrl() here — it reads the current pathname (already /login)
      // and would return plain /login, dropping the redirect_to destination.
      const redirectTo = new URLSearchParams(window.location.search).get('redirect_to');
      const loginPath =
        redirectTo && isSafeRedirect(redirectTo)
          ? `/login?redirect_to=${encodeURIComponent(redirectTo)}`
          : '/login';
      navigate(loginPath, { replace: true });
    },
  });
  const logoutUser = useLogoutUserMutation({
    onSuccess: (data) => {
      if (data.redirect) {
        /** data.redirect is the IdP's end_session_endpoint URL — an absolute URL generated
         * server-side from trusted IdP metadata (not user input), so isSafeRedirect is bypassed.
         * setUserContext is debounced (50ms) and won't fire before page unload, so clear the
         * axios Authorization header synchronously to prevent in-flight requests. */
        isExternalRedirectRef.current = true;
        setTokenHeader(undefined);
        window.location.replace(data.redirect);
        return;
      }
      setUserContext({
        token: undefined,
        isAuthenticated: false,
        user: undefined,
        redirect: '/login',
      });
    },
    onError: (error) => {
      doSetError((error as Error).message);
      setUserContext({
        token: undefined,
        isAuthenticated: false,
        user: undefined,
        redirect: '/login',
      });
    },
  });
  const refreshToken = useRefreshTokenMutation();

  const logout = useCallback(
    (redirect?: string) => {
      if (redirect) {
        logoutRedirectRef.current = redirect;
      }
      logoutUser.mutate(undefined);
    },
    [logoutUser],
  );

  const userQuery = useGetUserQuery({ enabled: !!(token ?? '') });

  const login = (data: t.TLoginUser) => {
    loginUser.mutate(data);
  };

  const silentRefresh = useCallback(() => {
    if (authConfig?.test === true) {
      console.log('Test mode. Skipping silent refresh.');
      return;
    }
    if (isExternalRedirectRef.current) {
      return;
    }
    refreshToken.mutate(undefined, {
      onSuccess: (data: t.TRefreshTokenResponse | undefined) => {
        if (isExternalRedirectRef.current) {
          return;
        }
        const { user, token = '' } = data ?? {};
        if (token) {
          refreshRetryRef.current = 0;
          const storedRedirect = sessionStorage.getItem(SESSION_KEY);
          sessionStorage.removeItem(SESSION_KEY);
          const baseUrl = apiBaseUrl();
          const rawPath = window.location.pathname;
          const strippedPath =
            baseUrl && (rawPath === baseUrl || rawPath.startsWith(baseUrl + '/'))
              ? rawPath.slice(baseUrl.length) || '/'
              : rawPath;
          const currentUrl = `${strippedPath}${window.location.search}`;
          const fallbackRedirect = isSafeRedirect(currentUrl) ? currentUrl : '/c/new';
          const redirect =
            storedRedirect && isSafeRedirect(storedRedirect) ? storedRedirect : fallbackRedirect;
          setUserContext({ user, token, isAuthenticated: true, redirect });
          return;
        }
        console.log('Token is not present. User is not authenticated.');
        if (authConfig?.test === true) {
          return;
        }
        refreshRetryRef.current = 0;
        navigate(buildLoginRedirectUrl());
      },
      onError: (error) => {
        if (isExternalRedirectRef.current) {
          return;
        }
        console.log('refreshToken mutation error:', error);
        if (authConfig?.test === true) {
          return;
        }
        if (isTransientAuthError(error) && refreshRetryRef.current < MAX_REFRESH_RETRIES) {
          // Transient failure (network / 5xx / IdP hiccup): retry with backoff instead of logging
          // the user out. A still-valid bearer keeps working and the proactive timer keeps re-arming.
          const delay = REFRESH_RETRY_DELAYS_MS[refreshRetryRef.current] ?? 15000;
          refreshRetryRef.current += 1;
          setTimeout(() => {
            if (!isExternalRedirectRef.current) {
              silentRefresh();
            }
          }, delay);
          return;
        }
        // Genuine auth failure (refresh token rejected) or retries exhausted: require re-login.
        refreshRetryRef.current = 0;
        navigate(buildLoginRedirectUrl());
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are stable at mount; adding refreshToken causes infinite re-fire
  }, []);

  useEffect(() => {
    if (isExternalRedirectRef.current) {
      return;
    }
    if (userQuery.data) {
      setUser(userQuery.data);
    } else if (userQuery.isError) {
      doSetError((userQuery.error as Error).message);
      // Only redirect to login on a genuine auth failure. A transient error (network / 5xx, e.g.
      // the backend briefly unavailable during a deploy) must not log the user out.
      if (!isTransientAuthError(userQuery.error)) {
        navigate(buildLoginRedirectUrl(), { replace: true });
      }
    }
    if (error != null && error && isAuthenticated) {
      doSetError(undefined);
    }
    if (token == null || !token || !isAuthenticated) {
      silentRefresh();
    }
  }, [
    token,
    isAuthenticated,
    userQuery.data,
    userQuery.isError,
    userQuery.error,
    error,
    setUser,
    navigate,
    silentRefresh,
    setUserContext,
  ]);

  /**
   * Proactively refresh the OIDC token before it expires. The Atriarch chat fork forwards the
   * signed-in user's OIDC access token to the inference API, so a tab left idle past the token's
   * ~1h lifetime forwards a stale token and the next send silently fails until a page reload
   * (which re-runs silentRefresh at mount). A self-rescheduling timer refreshes a couple of
   * minutes before expiry (capped at 10 min); the server reuses recently-refreshed tokens, so
   * frequent ticks are cheap. This keeps the forwarded token valid across idle gaps.
   */
  useEffect(() => {
    if (authConfig?.test === true || !token || !isAuthenticated) {
      return;
    }

    const MIN_DELAY = 60 * 1000;
    const MAX_DELAY = 10 * 60 * 1000;
    const EXPIRY_BUFFER = 2 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const decodeExpMs = (jwt: string): number | null => {
      try {
        const part = jwt.split('.')[1];
        if (!part) {
          return null;
        }
        const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as {
          exp?: number;
        };
        return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
      } catch {
        return null;
      }
    };

    const arm = () => {
      const expMs = decodeExpMs(token);
      const untilRefresh = expMs != null ? expMs - Date.now() - EXPIRY_BUFFER : MAX_DELAY;
      const delay = Math.max(MIN_DELAY, Math.min(untilRefresh, MAX_DELAY));
      timer = setTimeout(() => {
        /**
         * Refresh WITHOUT silentRefresh/useRefreshTokenMutation here: that mutation's onMutate
         * calls queryClient.removeQueries(), which wipes the entire React Query cache. When this
         * timer fired mid-generation, the conversation view blanked ("chat history gone"), the
         * unmounted stream consumer aborted the in-flight generation server-side ("Operation
         * aborted"), and nothing refetched until the submission ended. Use the same
         * non-destructive path as the 401 interceptor instead: fetch a token and broadcast
         * tokenUpdated (which also sets the axios header). Failures here are tolerable — a real
         * expiry is still covered by the interceptor and the next mount's silentRefresh.
         */
        request
          .refreshToken()
          .then((data: { token?: string } | undefined) => {
            const refreshed = data?.token ?? '';
            if (refreshed) {
              request.dispatchTokenUpdatedEvent(refreshed);
            }
          })
          .catch((error: unknown) => {
            console.log('proactive token refresh failed; interceptor will cover a real 401', error);
          })
          .finally(() => {
            // Re-arm even when the refreshed token is byte-identical (server-side token reuse),
            // since that case won't change `token` and re-run this effect.
            if (!cancelled) {
              arm();
            }
          });
      }, delay);
    };

    arm();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, isAuthenticated, authConfig?.test, silentRefresh]);

  useEffect(() => {
    const handleTokenUpdate = (event: CustomEvent<string>) => {
      console.log('tokenUpdated event received event');
      setUserContext({
        token: event.detail,
        isAuthenticated: true,
        user: user,
      });
    };

    window.addEventListener('tokenUpdated', handleTokenUpdate as EventListener);

    return () => {
      window.removeEventListener('tokenUpdated', handleTokenUpdate as EventListener);
    };
  }, [setUserContext, user]);

  const memoedValue = useMemo(
    () => ({
      user,
      token,
      error,
      login,
      logout,
      setError,
      roles: {
        [SystemRoles.USER]: userRole,
        [SystemRoles.ADMIN]: adminRole,
        ...(isCustomRole && customRole ? { [userRoleName]: customRole } : {}),
      },
      isAuthenticated,
    }),

    [
      user,
      error,
      isAuthenticated,
      token,
      userRole,
      adminRole,
      isCustomRole,
      userRoleName,
      customRole,
    ],
  );

  return <AuthContext.Provider value={memoedValue}>{children}</AuthContext.Provider>;
};

const useAuthContext = () => {
  const context = useContext(AuthContext);

  if (context === undefined) {
    throw new Error('useAuthContext should be used inside AuthProvider');
  }

  return context;
};

export { AuthContextProvider, useAuthContext, AuthContext };
