import { encode } from "next-auth/jwt";

type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: "LECTURER" | "STUDENT";
};

function isSecureAppUrl(): boolean {
  const appUrl = process.env.APP_URL ?? "";
  return appUrl.startsWith("https://");
}

export function getSessionCookieName(): string {
  return isSecureAppUrl() ? "__Secure-authjs.session-token" : "authjs.session-token";
}

export async function createSessionCookie(user: SessionUser): Promise<{
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: "lax";
    path: "/";
    secure: boolean;
  };
}> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: AUTH_SECRET");
  }

  const cookieName = getSessionCookieName();

  const token = await encode({
    secret,
    salt: cookieName,
    token: {
      sub: user.id,
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });

  return {
    name: cookieName,
    value: token,
    options: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: isSecureAppUrl(),
    },
  };
}
