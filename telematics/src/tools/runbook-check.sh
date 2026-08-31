#!/usr/bin/env bash
# Exercise the run-book's §3 curl commands against live servers, end to end.
# Used to verify docs/RUNBOOKS.md is literally correct. Not part of the suite.
set -u
cd "$(dirname "$0")/../.." || exit 1

INGEST_PORT=15027
API_PORT=18080
export INGEST_PORT API_PORT LOG_FORMAT=kv

node src/api/server.js > /tmp/rb-api.log 2>&1 &
API_PID=$!
node src/ingestion/server.js > /tmp/rb-ing.log 2>&1 &
ING_PID=$!
sleep 2

SIM_SERVER_PORT=$INGEST_PORT node src/simulator/run-simulator.js \
  --scenario handover --interval 0 > /tmp/rb-sim.log 2>&1

TENANT_A=11111111-1111-4111-8111-111111111111
TENANT_B=22222222-2222-4222-8222-222222222222
EXCAVATOR=a0000000-0000-4000-8000-000000000001
GENERATOR=a0000000-0000-4000-8000-000000000002

echo "== health =="
curl -s "localhost:${API_PORT}/health"; echo
echo "== A positions (count) =="
curl -s -H "X-Tenant-Id: ${TENANT_A}" "localhost:${API_PORT}/positions?limit=1000" \
  | tr ',' '\n' | grep -c tsMs
echo "== A devices =="
curl -s -H "X-Tenant-Id: ${TENANT_A}" "localhost:${API_PORT}/devices"; echo
echo "== A engine-hours (Excavator X, CAN) =="
curl -s -H "X-Tenant-Id: ${TENANT_A}" "localhost:${API_PORT}/assets/${EXCAVATOR}/engine-hours"; echo
echo "== B engine-hours (Generator Y, no CAN) =="
curl -s -H "X-Tenant-Id: ${TENANT_B}" "localhost:${API_PORT}/assets/${GENERATOR}/engine-hours"; echo
echo "== no tenant header =="
curl -s -o /dev/null -w '%{http_code}\n' "localhost:${API_PORT}/positions"

echo "== ingestion events =="
grep -o 'event=[a-z_]*' /tmp/rb-ing.log | sort | uniq -c

echo "== SIGTERM =="
kill -TERM $API_PID $ING_PID
wait $API_PID; echo "api exit=$?"
wait $ING_PID; echo "ingestion exit=$?"
grep -o 'event=shutdown_[a-z_]*' /tmp/rb-ing.log
