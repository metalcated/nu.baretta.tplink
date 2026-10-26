FROM node:24.21.0-bookworm-slim AS dependencies

# Installer dependencies stay outside the application's production tree.
RUN npm install --prefix /opt/homey-cli --ignore-scripts --no-audit --no-fund homey@4.6.1
ENV NODE_PATH=/opt/homey-cli/node_modules
ENV PATH=/opt/homey-cli/node_modules/.bin:${PATH}

WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/tplink-smarthome-api-5.0.4.tgz ./vendor/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && node -e 'const { Client } = require("tplink-smarthome-api"); if (typeof Client !== "function") process.exit(1)'

FROM dependencies AS verified
COPY . .
RUN node --test test/*.test.js \
    && node scripts/check-syntax.cjs \
    && homey app validate --level debug \
    && homey app build \
    && node scripts/check-package.cjs

FROM verified AS installer
ENV HOMEY_HOME=/auth
CMD ["sh", "-c", "if [ -n \"${HOMEY_ID:-}\" ]; then homey select --id \"$HOMEY_ID\"; else homey select; fi && node scripts/install-app.cjs"]
