// ==========================================================================
// CONFIGURACIÓN DE SUPABASE
// ==========================================================================
// 1. Ve a https://supabase.com y crea una cuenta (gratis)
// 2. "New project" — ponle un nombre, una contraseña de base de datos
//    (guárdala, no la necesitas para este proyecto pero Supabase la pide)
//    y elige la región más cercana a tus usuarios.
// 3. Espera 1-2 minutos a que el proyecto termine de crearse.
// 4. Ve a "SQL Editor" (menú lateral) → "New query" → pega TODO el
//    contenido de supabase-schema.sql → clic en "Run".
// 5. Ve a "Project Settings" (ícono de engranaje) → "API".
//    - Copia "Project URL" → pégalo abajo en `url`
//    - Copia "anon public" (la llave larga) → pégalo abajo en `anonKey`
// ==========================================================================

const SUPABASE_CONFIG = {
  url: "https://lheklouygplpljnffxtk.supabase.co/rest/v1/", 
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxoZWtsb3V5Z3BscGxqbmZmeHRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzOTk2MjcsImV4cCI6MjA5ODk3NTYyN30.os96vcVkt0dAN89en7FyApVB7WwotlAS5BI5VlUnlTE"
};
