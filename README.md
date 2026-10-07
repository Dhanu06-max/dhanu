# Saweria -> Roblox relay

Endpoint:
- POST /webhook  : dipanggil Saweria (signature diverifikasi)
- POST /test     : donasi palsu, butuh header x-admin-key (aktif kalau ADMIN_KEY diisi)
- GET  /         : cek server hidup

Env: SAWERIA_STREAM_KEY, ROBLOX_API_KEY, UNIVERSE_ID, ROBLOX_TOPIC (default Donation), ADMIN_KEY (opsional).
Start command: npm start
