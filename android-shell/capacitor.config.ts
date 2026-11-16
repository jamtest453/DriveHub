import type { CapacitorConfig } from '@capacitor/cli';

const appOrigin=(process.env.DRIVEHUB_APP_ORIGIN||'https://drive-hub-production-6748.up.railway.app').replace(/\/+$/,'');
const otaPublicKey=String(process.env.DRIVEHUB_OTA_PUBLIC_KEY||'').trim();
const otaChannel=/^(stable|beta)$/.test(String(process.env.DRIVEHUB_OTA_CHANNEL||''))?String(process.env.DRIVEHUB_OTA_CHANNEL):'stable';

const config: CapacitorConfig={
  appId:'app.drivehub.mobile',
  appName:'DriveHub',
  webDir:'web',
  server:{androidScheme:'https'},
  plugins:{
    CapacitorUpdater:{
      autoUpdate:'atBackground',
      version:'142.24.0',
      updateUrl:`${appOrigin}/api/app/update?channel=${otaChannel}`, 
      statsUrl:'',
      appReadyTimeout:10000,
      keepUrlPathAfterReload:true,
      ...(otaPublicKey?{publicKey:otaPublicKey}:{})
    }
  }
};

export default config;
