import { randomBytes } from 'crypto';
import { isPathProtected } from '@/app/path';
import NextAuth, { User } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

/**
 * Generates a new auth secret locally.
 *
 * The template previously fetched this from `generate-secret.vercel.app`,
 * which tied the app to a Vercel endpoint and broke container builds where
 * that host is unreachable. Generating locally is equally strong and has no
 * network dependency.
 */
export const generateAuthSecret = () =>
  Promise.resolve(randomBytes(32).toString('base64url'));

export const {
  handlers: { GET, POST },
  signIn,
  signOut,
  auth,
} = NextAuth({
  providers: [
    Credentials({
      async authorize({ email, password }) {
        if (
          process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL === email &&
          process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD === password
        ) {
          const user: User = { email, name: 'Admin User' };
          return user;
        } else {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;

      const isUrlProtected = isPathProtected(pathname);
      const isUserLoggedIn = !!auth?.user;
      const isRequestAuthorized = !isUrlProtected || isUserLoggedIn;

      return isRequestAuthorized;
    },
  },
  pages: {
    signIn: '/sign-in',
  },
});

export const runAuthenticatedAdminServerAction = async <T>(
  callback: () => T,
): Promise<T> => {
  const session = await auth();
  if (session?.user) {
    return callback();
  } else {
    throw new Error('Unauthorized server action request');
  }
};
