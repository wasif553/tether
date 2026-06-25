import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

declare module "next-auth" {
  interface User {
    role?: "LECTURER" | "STUDENT";
  }
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      role: "LECTURER" | "STUDENT";
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
        };
      },
    }),
  ],
  callbacks: {
    jwt: async ({ token, user }) => {
      if (user) {
        (token as Record<string, unknown>).id = user.id;
        (token as Record<string, unknown>).role = user.role;
      }
      return token;
    },
    session: async ({ session, token }) => {
      if (session.user) {
        session.user.id = (token as Record<string, unknown>).id as string;
        session.user.role = (token as Record<string, unknown>).role as
          | "LECTURER"
          | "STUDENT";
      }
      return session;
    },
  },
});
