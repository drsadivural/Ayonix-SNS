import { createContext } from 'react';

/** The selected workspace id; useApi keys requests by it so switching refetches. */
export const WorkspaceIdContext = createContext<string | null>(null);
