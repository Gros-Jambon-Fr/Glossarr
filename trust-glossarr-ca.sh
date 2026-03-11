#!/bin/bash
# Trusts the Glossarr CA certificate in Sonarr's container.
# Mount this file into /custom-cont-init.d/ in your Sonarr container.
cp /custom-cont-init.d/glossarr-ca.crt /usr/local/share/ca-certificates/glossarr-ca.crt
update-ca-certificates
