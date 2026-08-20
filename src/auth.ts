import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { applyJwtUpdate } from "@/lib/sessionRefresh";
import { attemptCredentialsLogin } from "@/lib/security/loginAttempt";
import { resolveTrustedRequestSource } from "@/lib/security/clientSource";

declare module "next-auth" {
  interface User {
    role?: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN";
    institutionId?: string | null;
  }
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN";
      institutionId: string | null;
    };
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      // Auth and Token Abuse Protection v1 — the actual verification
      // logic (lookup, bcrypt compare, and durable, concurrency-safe
      // rate limiting) lives in attemptCredentialsLogin
      // (src/lib/security/loginAttempt.ts), extracted so it's directly
      // unit-testable without NextAuth's internal request-handling
      // pipeline. `request` is NextAuth v5's own second `authorize`
      // parameter — the original inbound Request, carrying whatever
      // headers actually reached this server (see
      // resolveTrustedRequestSource's own doc comment for the Vercel
      // trust boundary this relies on).
      authorize: async (credentials, request) => {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        const sourceIp = resolveTrustedRequestSource(request);
        return attemptCredentialsLogin({ email, password, sourceIp });
      },
    }),
  ],
  callbacks: {
    jwt: async ({ token, user, trigger }) => {
      if (user) {
        (token as Record<string, unknown>).id = user.id;
        (token as Record<string, unknown>).role = user.role;
        (token as Record<string, unknown>).institutionId = user.institutionId ?? null;
        return token;
      }
      // Tether Course Invitation + Acceptance v1 hardening — see
      // src/lib/sessionRefresh.ts's own doc comment for the full
      // reasoning. Only refreshes institutionId from the database when
      // the client explicitly calls `useSession().update()`; an
      // ordinary request (trigger undefined) is a pure no-op, exactly
      // the pre-hardening behavior.
      return applyJwtUpdate(token as Record<string, unknown>, trigger);
    },
    session: async ({ session, token }) => {
      if (session.user) {
        session.user.id = (token as Record<string, unknown>).id as string;
        session.user.role = (token as Record<string, unknown>).role as
          | "LECTURER"
          | "STUDENT"
          | "PLATFORM_ADMIN";
        // Old sessions minted before this field existed will have
        // token.institutionId === undefined — normalize to null so
        // requireInstitutionId() (src/lib/institutionScope.ts) can detect
        // and reject them with a clear "log in again" message, rather
        // than silently treating `undefined` as a valid falsy bypass.
        session.user.institutionId =
          ((token as Record<string, unknown>).institutionId as string | null | undefined) ?? null;
      }
      return session;
    },
  },
});
