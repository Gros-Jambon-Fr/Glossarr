#!/bin/bash
set -e

CERTS_DIR="$(dirname "$0")/certs"
mkdir -p "$CERTS_DIR"

echo "Generating CA key and certificate..."
openssl genrsa -out "$CERTS_DIR/ca.key" 4096 2>/dev/null
openssl req -new -x509 -days 3650 \
  -key "$CERTS_DIR/ca.key" \
  -out "$CERTS_DIR/ca.crt" \
  -subj "/CN=Glossarr CA" 2>/dev/null

echo "Generating server key and certificate..."
openssl genrsa -out "$CERTS_DIR/server.key" 2048 2>/dev/null
openssl req -new \
  -key "$CERTS_DIR/server.key" \
  -out "$CERTS_DIR/server.csr" \
  -subj "/CN=skyhook.sonarr.tv" 2>/dev/null
openssl x509 -req -days 3650 \
  -in "$CERTS_DIR/server.csr" \
  -CA "$CERTS_DIR/ca.crt" \
  -CAkey "$CERTS_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERTS_DIR/server.crt" \
  -extfile <(printf "subjectAltName=DNS:skyhook.sonarr.tv") 2>/dev/null

rm -f "$CERTS_DIR/server.csr" "$CERTS_DIR/ca.srl"

echo ""
echo "Done. Certificates generated in $CERTS_DIR:"
echo "  ca.crt     — mount this into Sonarr to trust Glossarr"
echo "  server.crt — TLS certificate used by Glossarr"
echo "  server.key — TLS private key used by Glossarr"
