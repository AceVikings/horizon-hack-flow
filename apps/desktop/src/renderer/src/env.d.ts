/// <reference types="vite/client" />
import type { AteBridge } from "@shared/bridge";
declare global {
  interface Window {
    ate?: AteBridge;
  }
}
export {};
