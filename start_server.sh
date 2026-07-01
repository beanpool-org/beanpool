cd apps/server
npm run dev &
PID=$!
sleep 5
kill $PID
