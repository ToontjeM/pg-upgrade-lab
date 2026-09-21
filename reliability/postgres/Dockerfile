# Plain community PostgreSQL -- the failover-persistent logical slot
# behavior this demo compares (see entrypoint.sh) doesn't depend on an
# EDB-specific build. PG_VERSION picks which major version this image is,
# built once per version by docker-compose.yml (16 = old, 18 = new).
ARG PG_VERSION=18
FROM postgres:${PG_VERSION}

COPY entrypoint.sh /usr/local/bin/pg-entrypoint.sh
COPY init-publication.sh /docker-entrypoint-initdb.d/10-init-publication.sh
RUN chmod +x /usr/local/bin/pg-entrypoint.sh /docker-entrypoint-initdb.d/10-init-publication.sh

ENTRYPOINT ["pg-entrypoint.sh"]
CMD ["postgres"]
