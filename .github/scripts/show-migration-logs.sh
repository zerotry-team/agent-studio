#!/usr/bin/env bash
set -euo pipefail
TASK=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN")
DEFINITION=$(jq -r '.tasks[0].taskDefinitionArn' <<< "$TASK")
jq '{failures, tasks: [.tasks[] | {lastStatus, stoppedReason, containers: [.containers[] | {name, exitCode, reason}]}]}' <<< "$TASK"
OPTIONS=$(aws ecs describe-task-definition --task-definition "$DEFINITION" --query "taskDefinition.containerDefinitions[?name=='api'].logConfiguration.options | [0]" --output json)
GROUP=$(jq -r '.["awslogs-group"]' <<< "$OPTIONS")
PREFIX=$(jq -r '.["awslogs-stream-prefix"]' <<< "$OPTIONS")
aws logs get-log-events --log-group-name "$GROUP" --log-stream-name "${PREFIX}/api/${TASK_ARN##*/}" --start-from-head --query 'events[].message' --output text
