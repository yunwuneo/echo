-- Refuse ambiguous historical duplicate IDs instead of discarding receipts.
CREATE UNIQUE INDEX tool_calls_operation_identity ON tool_calls(run_id,model_call_id);
