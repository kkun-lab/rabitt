// ==========================================================================
// CONFIGURACIÓN DE FIREBASE
// ==========================================================================
// 1. Ve a https://console.firebase.google.com
// 2. Crea un proyecto nuevo (gratis, plan "Spark")
// 3. Dentro del proyecto: Build > Realtime Database > Create Database
//    - Elige el modo de prueba ("test mode") para empezar rápido
// 4. Ve a Project Settings (el ícono de engranaje) > General
//    - Baja hasta "Your apps" > el ícono </> (Web) > registra una app
//    - Copia el objeto firebaseConfig que te muestra y pégalo abajo
// ==========================================================================

const firebaseConfig = {
  apiKey: "PEGA_AQUI_TU_API_KEY",
  authDomain: "PEGA_AQUI_TU_PROYECTO.firebaseapp.com",
  databaseURL: "https://PEGA_AQUI_TU_PROYECTO-default-rtdb.firebaseio.com",
  projectId: "PEGA_AQUI_TU_PROYECTO",
  storageBucket: "PEGA_AQUI_TU_PROYECTO.appspot.com",
  messagingSenderId: "PEGA_AQUI_TU_SENDER_ID",
  appId: "PEGA_AQUI_TU_APP_ID"
};
