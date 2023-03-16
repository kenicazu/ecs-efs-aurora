import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as aws_ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as efs from "aws-cdk-lib/aws-efs";
import { CfnOutput, Duration } from "aws-cdk-lib";

export class JMAWorkshopStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "JMAVPC", {
      cidr: "10.0.0.0/16",
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "isolatedSubnet",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    const engine = rds.DatabaseClusterEngine.auroraMysql({
      version: rds.AuroraMysqlEngineVersion.VER_3_02_1,
    });

    const databaseName = "JMAPoC";

    const dbCluster = new rds.DatabaseCluster(this, "AuroraCluster", {
      engine: engine,
      defaultDatabaseName: databaseName,
      instanceProps: {
        vpc: vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      },
    });

    const cluster = new aws_ecs.Cluster(this, "JMACluster", {
      vpc: vpc,
      containerInsights: true,
      enableFargateCapacityProviders: true,
    });
    
    
    // for ECS Exec Role
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
  
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
          "elasticfilesystem:*",
        ],
        resources: ["*"],
      })
    );
    
    const sgForEFS = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Allow EFS access from Fargate',
      allowAllOutbound: true   // Can be set to false
    });
    
    sgForEFS.connections.allowFromAnyIpv4(ec2.Port.tcp(2049), 'allow file access from the world');
    
    const fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc: vpc,
      fileSystemName: 'jma-efs-file',
      securityGroup: sgForEFS
    });
    
    const volumeConfig = {
      name: "efs-volume",
      // this is the main config
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
      },
    };
    
    const mountPoints: aws_ecs.MountPoint = {
        containerPath: "/file",
        sourceVolume: volumeConfig.name,
        readOnly: false,
    };
    
    const taskDefinition = new aws_ecs.FargateTaskDefinition(this, "Apache", {
      memoryLimitMiB: 512,
      taskRole,
      volumes: [volumeConfig],
    });

    const container = taskDefinition.addContainer("Apache", {
      image: aws_ecs.ContainerImage.fromRegistry("httpd:latest"),
      portMappings: [{ containerPort: 80 }],
    });
    
    container.addMountPoints(mountPoints)
    
    dbCluster.secret?.grantRead(taskDefinition.taskRole);

    const ecsService = new aws_ecs.FargateService(this, "FargateService", {
      cluster: cluster,
      taskDefinition: taskDefinition,
      assignPublicIp: true,
      desiredCount: 2,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });
    
    // Security Group for ALB
    const sgForAlb = new ec2.SecurityGroup(this, "sg-for-alb", {
      vpc: vpc,
      allowAllOutbound: true,
    });
    sgForAlb.connections.allowFromAnyIpv4(ec2.Port.tcp(80), "Allow inbound HTTP");

    // ALBを追加
    const alb = new elbv2.ApplicationLoadBalancer(this, "alb", {
      loadBalancerName: `jma-alb`,
      vpc: vpc,
      internetFacing: true,
      securityGroup: sgForAlb,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
    });

    const listener = alb.addListener("Listener", {
      port: 80,
    });

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc: vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/",
        interval: Duration.seconds(60),
        healthyHttpCodes: "200",
      },
    });

    listener.addTargetGroups("ListnerTargetGroup", {
      targetGroups: [targetGroup],
    });

    // ECSをALBのターゲットへ追加
    ecsService.attachToApplicationTargetGroup(targetGroup);

    // データベースのクラスターを変更
    ecsService.connections.allowTo(dbCluster.connections, ec2.Port.tcp(3306));

    // AutoScaling
    const scaling = ecsService.autoScaleTaskCount({ maxCapacity: 20 });
    scaling.scaleOnRequestCount("RequestScaling", {
      requestsPerTarget: 100,
      targetGroup: targetGroup,
    });
    
    
    const CfnService = ecsService.node.defaultChild as aws_ecs.CfnService
    CfnService.addPropertyOverride("EnableExecuteCommand", true)
    
    new CfnOutput(this, "AlbDnsName", { value: alb.loadBalancerDnsName });
  }
}
