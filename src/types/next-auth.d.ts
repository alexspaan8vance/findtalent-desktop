import type { DefaultSession } from 'next-auth';

export type AppRole = 'ADMIN' | 'CUSTOMER';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: AppRole;
      /** May access the Candidates surface. Undefined on legacy tokens = allowed
       * (grandfathered); only an explicit `false` blocks. */
      candidatesEnabled?: boolean;
    } & DefaultSession['user'];
  }

  interface User {
    id: string;
    role: AppRole;
    candidatesEnabled?: boolean;
  }
}
