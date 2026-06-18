import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React 19 CJS interop: `act` is an ESM-only named export.
// Add it to the CJS module so react-dom/test-utils can find React.act.
// vi.mock('react') in each test file provides the polyfill.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});