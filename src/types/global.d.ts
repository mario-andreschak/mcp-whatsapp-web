// Add TypeScript declaration for global.gc
declare global {
  namespace NodeJS {
    interface Global {
      gc?: () => void;
    }
  }
}

export {};
