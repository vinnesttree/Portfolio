# syntax=docker/dockerfile:1

# Static portfolio served by nginx as a non-root user.
FROM nginxinc/nginx-unprivileged:1.30-alpine

# Replace the stock welcome page and server config.
USER root
RUN rm -rf /usr/share/nginx/html/*
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/
USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
