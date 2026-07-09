/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_N1?: string;
  readonly VITE_N2?: string;
  readonly VITE_N3?: string;
  readonly VITE_N4?: string;
  readonly VITE_NODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
