/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API base URL including /api path. Example: https://my-backend.railway.app/api */
  readonly VITE_API_BASE_URL?: string;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
