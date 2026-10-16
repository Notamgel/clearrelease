# Guía para mañana: ClearRelease → bounty Chainlink CRE (BLI Legal Tech Hackathon 2)

Tiempo estimado: **2–3 horas.** Costo: **$0** (todo es testnet). Fecha límite: **1 nov 2026, 01:01**
(hora mostrada por DoraHacks). Conviene enviarlo cuanto antes y actualizarlo después; DoraHacks
permite editar el BUIDL.

## 0. Copia el proyecto a un lugar seguro (la carpeta /private/tmp se borra al reiniciar)
```bash
mkdir -p ~/Desktop/bounties
rsync -a --exclude node_modules --exclude artifacts --exclude cache \
  "/private/tmp/claude-501/-Users-notamgel-Desktop-canU/fae5f721-583d-4ad0-a2b9-0136bfb86c9f/scratchpad/bounties/" ~/Desktop/bounties/
cd ~/Desktop/bounties/01-chainlink-cre-clearrelease
```

## 1. Instala las herramientas (10 min)
```bash
curl -fsSL https://bun.sh/install | bash               # Bun (luego abre una terminal nueva)
curl -sSL https://app.chain.link/cre/install.sh | bash  # CLI de CRE (instrucción oficial de docs.chain.link/cre)
cre version
```

## 2. Crea tu cuenta CRE e inicia sesión (5 min)
1. Entra a https://app.chain.link/cre/discover y pulsa **Create an account**. Usa notamgel@gmail.com,
   país México, código de 6 dígitos por correo y una contraseña (no la guardes en ningún archivo).
2. En la terminal: `cre login`. Se abre el navegador; autoriza. Verifícalo con `cre whoami`.

## 3. Pruebas locales (5 min)
```bash
cd contracts/evm && npm install && npx hardhat test   # debe decir: 14 passing
cd ../../screening-workflow && bun install && bun test  # debe decir: 21 pass
cd ..
```

## 4. Primera simulación sin desplegar nada (2 min): ¡toma captura!
```bash
cre workflow simulate screening-workflow --target staging-settings --non-interactive \
  --trigger-index 0 \
  --http-payload '{"addresses":["0x1111111111111111111111111111111111111111","0x0330070FD38Ec3bB94F58FA55D40368271E9e54A","0x038989cbb1710c72b9920dc4fa529158f463e72c"]}'
```
Resultado esperado: el veredicto es CLEAR, HIT y HIT. La tercera dirección aparece en la lista
OFAC, pero el oráculo **no** la marca.

> Si el CLI se queja de la dirección `0x000…` del escrow, haz primero el paso 5 (desplegar) y
> repite este paso.

## 5. Flujo completo en Sepolia (30–40 min)
1. **Crea una wallet NUEVA solo para testnet.** No uses tu wallet real. Por ejemplo, en
   MetaMask: *Add account*, luego *Account details* → *Show private key*.
2. **Consigue Sepolia ETH gratis** (0.05 es suficiente) en https://cloud.google.com/application/web3/faucet/ethereum/sepolia
   o en https://faucets.chain.link/sepolia.
3. **Configura y despliega:**
```bash
cp .env.example .env
# edita .env y pon:  CRE_ETH_PRIVATE_KEY=0x<llave de la wallet de PRUEBA>
export PRIVATE_KEY=0x<misma llave de PRUEBA>
(cd contracts/evm && npx hardhat run scripts/deploy.js --network sepolia)
```
   Esto imprime la dirección del contrato y la escribe sola en `screening-workflow/config.staging.json`.
   **Guarda la dirección.**

4. **Abre un escrow:**
```bash
(cd contracts/evm && ACTION=open npx hardhat run scripts/demo.js --network sepolia)
```
   El script imprime el comando `cre workflow simulate ... --trigger-index 1 --evm-tx-hash ... --broadcast`.
   **Cópialo y ejecútalo desde la carpeta del proyecto.** El escrow pasa a *Active*.

5. **Aprueba el pago:**
```bash
(cd contracts/evm && ACTION=approve ESCROW_ID=1 npx hardhat run scripts/demo.js --network sepolia)
```
   Ejecuta el comando `cre workflow simulate` que imprime. El escrow pasa a *Released*.

6. **Demo de congelamiento** (pagador limpio, beneficiario sancionado; solo testnet, los fondos
   nunca llegan a esa dirección):
```bash
(cd contracts/evm && ACTION=open PAYEE=0x038989cbb1710c72b9920dc4fa529158f463e72c npx hardhat run scripts/demo.js --network sepolia)
```
   Ejecuta el `simulate` impreso. Luego revisa el estado:
```bash
(cd contracts/evm && ACTION=status ESCROW_ID=2 npx hardhat run scripts/demo.js --network sepolia)   # status: Frozen
```

7. **Cron:**
```bash
cre workflow simulate screening-workflow --target staging-settings --non-interactive --trigger-index 2 --broadcast
```

**Anota los tx hashes** (aparecen en Etherscan Sepolia) para `SUBMISSION.md`.

## 6. Súbelo a GitHub (10 min)
1. En https://github.com/new crea el repo **clearrelease** como **Public**, sin README.
2. Desde la carpeta del proyecto:
```bash
git init && git add . && git status   # REVISA que .env NO aparezca en la lista
git commit -m "ClearRelease: sanctions-gated legal escrow on Chainlink CRE"
git branch -M main
git remote add origin https://github.com/<TU_USUARIO>/clearrelease.git
git push -u origin main
```

## 7. Video (20–30 min)
Sigue `VIDEO-SCRIPT.md`. Grábalo con QuickTime (Archivo → Nueva grabación de pantalla) y súbelo
a YouTube como **Unlisted** (no listado).

## 8. Envío en DoraHacks (15 min)
1. Entra a https://dorahacks.io → **Log in** (puedes usar Google con notamgel@gmail.com).
2. Abre https://dorahacks.io/hackathon/legal-hack-2026/detail y pulsa **Register**.
3. Pulsa **Submit Build** → **Create new BUIDL**. Rellena los campos con `SUBMISSION.md`:
   - Name, Logo (opcional), Vision
   - GitHub
   - Demo video
   - Details (pega toda la sección "Description")
4. En **Track** elige *LegalTech & RegTech*. En **Bounties** marca **Best workflow with CRE**
   (Chainlink).
5. Contacto: notamgel@gmail.com.
6. Wallet de cobro: pregunta en la pestaña Q&A qué red usan. Si aceptan Solana, usa
   `7EHnr1aT5LvxSXjsC794ir5HcoqNu72cjjSDz3s6uV78`. Si piden EVM, usa la dirección Ethereum de
   tu wallet multichain (no la de prueba).
7. Pulsa **Submit**.

## Reglas de seguridad
- Nunca subas `.env` ni pegues tu llave privada en ningún lado.
- La wallet de prueba solo se usa en Sepolia.
- Si algo falla, copia el error completo y pídele ayuda a Claude Code con la ruta del proyecto.
