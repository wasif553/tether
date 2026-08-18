import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { applyJwtUpdate } from "@/lib/sessionRefresh";

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
      authorize: async (credentials) => {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          institutionId: user.institutionId,
        };
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
