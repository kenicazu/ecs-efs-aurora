# ECS/Fargate + EFSマウント +Aurora デプロイテンプレート

## 動作環境

- AWS CLI
- Node.js 14以上
- jq

## デプロイ
npm ci
cdk deploy

## スケーリングポリシー

- ターゲット追跡スケーリングポリシー（ALBRequestCountPerTarget）
  - https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html
- ターゲットあたりのリクエスト数が100
- Maxのタスク数は20
