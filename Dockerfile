# Build CRA dashboard
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY src ./src
# Default for Railway when build-time variable is not injected (override in Railway Variables).
ARG REACT_APP_API_URL=https://productionbackend-production-1b08.up.railway.app
ENV REACT_APP_API_URL=$REACT_APP_API_URL
RUN npm run build

# Serve static build with nginx on Railway's $PORT
FROM nginx:1.27-alpine

# Remove default config (listens on 80 only — Railway routes to $PORT)
RUN rm -f /etc/nginx/conf.d/default.conf

COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/build /usr/share/nginx/html

# Railway injects PORT at runtime; template is processed by nginx entrypoint
ENV PORT=8080
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
