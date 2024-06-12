import * as cdk from 'aws-cdk-lib';
import { Annotations } from 'aws-cdk-lib';
import { Peer, Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AwsLogDriver, Capability, Cluster, ContainerImage, Ec2Service, Ec2TaskDefinition, LinuxParameters, NetworkMode, PlacementStrategy, Protocol } from 'aws-cdk-lib/aws-ecs';
import { NetworkLoadBalancer, NetworkTargetGroup, Protocol as ProtocolELB } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { DnsRecordType, PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class TqsftWgAdminStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const WgHost = new cdk.CfnParameter(this, "WgHost", {
      type: "String",
      description: "WireGuard Host",
    });

    const WgAdminPwd = new cdk.CfnParameter(this, "WgAdminPassword", {
      type: "String",
      description: "Easy WireGuard Admin Password",
    })

    // Parameters required
    const vpcId = StringParameter.valueFromLookup(this, 'TqsftStack-VpcId');
    const ecsClusterName = cdk.Fn.importValue('TqsftStack-ClusterName');
    const nlbArn = cdk.Fn.importValue('TqsftStack-NLBArn');
    const nlbSgId = cdk.Fn.importValue('TqsftStack-NLBSG');
    const dnsNsId = cdk.Fn.importValue('TqsftStack-NsId');
    const dnsNsArn = cdk.Fn.importValue('TqsftStack-NsArn');
    const dnsNsName = cdk.Fn.importValue('TqsftStack-NsName');
    
    const nlbSg = SecurityGroup.fromSecurityGroupId(this, 'NLB-SG', nlbSgId)
    const vpc = Vpc.fromLookup(this, "vpc", {
      vpcId: vpcId
    });

    const s3Bucket = Bucket.fromBucketName(this, "EcsClustersSpace", "ecs-clusters-space");

    const ecsCluster = Cluster.fromClusterAttributes(this, "ecsCluster", {
      clusterName: ecsClusterName,
      vpc: vpc,
      securityGroups: [  ]
    })

    const tqsftLogGroup = LogGroup.fromLogGroupName(this, "TqsftLogGroup", "/ecs/tqsft-services");

    const TqsftDnsNs = PrivateDnsNamespace.fromPrivateDnsNamespaceAttributes(this, "PrivateDnsNS", {
      namespaceId: dnsNsId,
      namespaceArn: dnsNsArn,
      namespaceName: dnsNsName,
    })

    const ecsPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [ '*' ],
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents'
      ]
    });

    const wgAdminLogDriver = new AwsLogDriver({
      streamPrefix: 'WgAdminLogs',
      logGroup: tqsftLogGroup
    });

    const wgAdminTaskDef = new Ec2TaskDefinition(this, 'WgAdmin-TaskDef', {
      networkMode: NetworkMode.AWS_VPC
    })

    const linuxParameters = new LinuxParameters(this, 'LinuxParameters', {})
    linuxParameters.addCapabilities(Capability.NET_ADMIN)
    linuxParameters.addCapabilities(Capability.SYS_MODULE)

    var wgAdminPassword : string = WgAdminPwd.valueAsString;
    var wgAdminHost : string = WgHost.valueAsString;

    const wgAdminContainer = wgAdminTaskDef.addContainer('WgAdminContainer', {
      image: ContainerImage.fromRegistry("ghcr.io/teqsoft/wg-easy:development"),
      cpu: 256,
      memoryLimitMiB: 512,
      logging: wgAdminLogDriver,
      containerName: "WgAdmin",
      privileged: true,
      linuxParameters: linuxParameters,
      systemControls: [ {
        namespace: 'net.ipv4.conf.all.src_valid_mark',
        value: '1'
      }, {
        namespace: 'net.ipv4.conf.all.proxy_arp',
        value: '1'
      }, {
        namespace: 'net.ipv4.ip_forward',
        value: '1'
      }],
      environment: {
        "WG_HOST": wgAdminHost,
        "PASSWORD": wgAdminPassword,
        "WG_S3_CONFIG": s3Bucket.s3UrlForObject("/WgAdmin/wg0.json"),
        "WG_PORT": "10443"
      }
    })

    wgAdminContainer.addPortMappings({
      containerPort: 51821,
      hostPort: 51821,
      name: "web"
    })

    wgAdminContainer.addPortMappings({
      containerPort: 10443,
      hostPort: 10443,
      name: "vpn-access",
      protocol: Protocol.UDP
    })

    wgAdminContainer.addToExecutionPolicy(ecsPolicy)
    wgAdminTaskDef.addToExecutionRolePolicy(ecsPolicy)
    wgAdminTaskDef.addToTaskRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        's3:ListBucket',
        's3:ListObjectsV2',
        's3:GetObject',
        's3:PutObject'
      ],
      resources: [
        'arn:aws:s3:::ecs-clusters-space',
        'arn:aws:s3:::ecs-clusters-space/',
        'arn:aws:s3:::ecs-clusters-space/*'
      ]
    }));

    const wgAdminService = new Ec2Service(this, 'WgAdminService', {
      serviceName: 'WgAdminService',
      cluster: ecsCluster,
      taskDefinition: wgAdminTaskDef,
      desiredCount: 0,
      placementStrategies: [
        PlacementStrategy.packedByMemory(),
        PlacementStrategy.packedByCpu(),
      ],
      capacityProviderStrategies: [
        // {
        //   capacityProvider: "BottlerocketCapProvider",
        //   weight: 1,
        // },
        {
          capacityProvider: "AL2023AsgCapProvider",
          weight: 1,
        }
      ],
      cloudMapOptions: {
        name: 'wg-admin',
        cloudMapNamespace: TqsftDnsNs,
        dnsRecordType: DnsRecordType.A
      },
      enableExecuteCommand: true
    });

    wgAdminService.connections.allowFromAnyIpv4(Port.tcp(51821));
    wgAdminService.connections.allowFromAnyIpv4(Port.udp(10443));

    const nlb = NetworkLoadBalancer.fromNetworkLoadBalancerAttributes(this, 'Tqsft-NLB', {
      // loadBalancerArn: `arn:aws:elasticloadbalancing:${process.env.CDK_DEFAULT_REGION}:${process.env.CDK_DEFAULT_ACCOUNT}:${nlbArn}`
      loadBalancerArn: nlbArn
    })

    const nlbWgAdminListener = nlb.addListener('WgAdminListener', {
      port: 10443,
      protocol: ProtocolELB.UDP
    });

    const nlbWgAdminHttpListener = nlb.addListener('WgAdminHttpListener', {
      port: 8080,
      protocol: ProtocolELB.TCP
    });

    const wgAdminTargetGroup = new NetworkTargetGroup(this, 'WgAdminTarget', {
      targetGroupName: "WgAdminTargetGroup",
      port: 10443,
      targets: [
        wgAdminService.loadBalancerTarget({
          containerName: "WgAdmin",
          containerPort: 10443,
          protocol: Protocol.UDP
        })
      ],
      protocol: ProtocolELB.UDP,
      vpc: vpc,
      healthCheck: {
        path: "/",
        protocol: ProtocolELB.HTTP,
        port: "51821",
        healthyHttpCodes: "200-299"
      }
    })

    const wgAdminHttpTargetGroup = new NetworkTargetGroup(this, 'WgAdminHttpTarget', {
      targetGroupName: "WgAdminHttpTargetGroup",
      port: 8080,
      targets: [
        wgAdminService.loadBalancerTarget({
          containerName: "WgAdmin",
          containerPort: 51821,
          protocol: Protocol.TCP
        })
      ],
      vpc: vpc,
      protocol: ProtocolELB.TCP
    })

    nlbWgAdminListener.addTargetGroups('WgAdminTarget', wgAdminTargetGroup)
    nlbWgAdminHttpListener.addTargetGroups('WgAdminHttpTarget', wgAdminHttpTargetGroup)

    nlbSg.addIngressRule(
      Peer.anyIpv4(), 
      Port.tcp(8080), 
      "Ingress for HTTPS"
    )

    nlbSg.addIngressRule(
      Peer.anyIpv4(), 
      Port.udp(10443), 
      "Ingress for HTTPS"
    )

  }
}
