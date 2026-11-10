FROM node:26-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev && \
    npm cache clean --force

COPY --chown=node:node *.js ./

# Check js syntax
RUN for file in ./*.js; do \
    [ -f "$file" ] || continue; \
    node --check "$file" || exit 1; \
done

# Run as non-root user
USER node

CMD ["node", "main.js"]
