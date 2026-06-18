import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-leaflet') || id.includes('/leaflet/')) return 'maps';
          if (id.includes('/recharts/')) return 'charts';
          if (id.includes('@phosphor-icons')) return 'icons';
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react';
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080'
    }
  }
});
