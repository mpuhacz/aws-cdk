import { Match, Template } from '@aws-cdk/assertions';
import * as iam from '@aws-cdk/aws-iam';
import * as kms from '@aws-cdk/aws-kms';
import * as s3 from '@aws-cdk/aws-s3';
import * as cdk from '@aws-cdk/core';
import * as cxapi from '@aws-cdk/cx-api';
import * as codepipeline from '../lib';
import { FakeBuildAction } from './fake-build-action';
import { FakeSourceAction } from './fake-source-action';

/* eslint-disable quote-props */

describe('', () => {
  describe('Pipeline', () => {
    test('can be passed an IAM role during pipeline creation', () => {
      const stack = new cdk.Stack();
      const role = new iam.Role(stack, 'Role', {
        assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      });
      const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
        role,
      });

      // Adding 2 stages with actions so pipeline validation will pass
      const sourceArtifact = new codepipeline.Artifact();
      pipeline.addStage({
        stageName: 'Source',
        actions: [new FakeSourceAction({
          actionName: 'FakeSource',
          output: sourceArtifact,
        })],
      });

      pipeline.addStage({
        stageName: 'Build',
        actions: [new FakeBuildAction({
          actionName: 'FakeBuild',
          input: sourceArtifact,
        })],
      });

      Template.fromStack(stack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
        'RoleArn': {
          'Fn::GetAtt': [
            'Role1ABCC5F0',
            'Arn',
          ],
        },
      });


    });

    test('can be imported by ARN', () => {
      const stack = new cdk.Stack();

      const pipeline = codepipeline.Pipeline.fromPipelineArn(stack, 'Pipeline',
        'arn:aws:codepipeline:us-east-1:123456789012:MyPipeline');

      expect(pipeline.pipelineArn).toEqual('arn:aws:codepipeline:us-east-1:123456789012:MyPipeline');
      expect(pipeline.pipelineName).toEqual('MyPipeline');


    });

    describe('that is cross-region', () => {
      test('validates that source actions are in the same region as the pipeline', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'PipelineStack', { env: { region: 'us-west-1', account: '123456789012' } });
        const pipeline = new codepipeline.Pipeline(stack, 'Pipeline');
        const sourceStage = pipeline.addStage({
          stageName: 'Source',
        });
        const sourceAction = new FakeSourceAction({
          actionName: 'FakeSource',
          output: new codepipeline.Artifact(),
          region: 'ap-southeast-1',
        });

        expect(() => {
          sourceStage.addAction(sourceAction);
        }).toThrow(/Source action 'FakeSource' must be in the same region as the pipeline/);


      });

      test('allows passing an Alias in place of the KMS Key in the replication Bucket', () => {
        const app = new cdk.App();

        const replicationRegion = 'us-west-1';
        const replicationStack = new cdk.Stack(app, 'ReplicationStack', {
          env: { region: replicationRegion, account: '123456789012' },
        });
        const replicationKey = new kms.Key(replicationStack, 'ReplicationKey');
        const replicationAlias = replicationKey.addAlias('alias/my-replication-alias');
        const replicationBucket = new s3.Bucket(replicationStack, 'ReplicationBucket', {
          encryptionKey: replicationAlias,
          bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
        });

        const pipelineRegion = 'us-west-2';
        const pipelineStack = new cdk.Stack(app, 'PipelineStack', {
          env: { region: pipelineRegion, account: '123456789012' },
        });
        const sourceOutput = new codepipeline.Artifact();
        new codepipeline.Pipeline(pipelineStack, 'Pipeline', {
          crossRegionReplicationBuckets: {
            [replicationRegion]: replicationBucket,
          },
          stages: [
            {
              stageName: 'Source',
              actions: [new FakeSourceAction({
                actionName: 'Source',
                output: sourceOutput,
              })],
            },
            {
              stageName: 'Build',
              actions: [new FakeBuildAction({
                actionName: 'Build',
                input: sourceOutput,
                region: replicationRegion,
              })],
            },
          ],
        });

        Template.fromStack(pipelineStack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
          'ArtifactStores': [
            Match.objectLike({
              'Region': replicationRegion,
              'ArtifactStore': {
                'Type': 'S3',
                'EncryptionKey': {
                  'Type': 'KMS',
                  'Id': {
                    'Fn::Join': [
                      '',
                      [
                        'arn:',
                        {
                          'Ref': 'AWS::Partition',
                        },
                        ':kms:us-west-1:123456789012:alias/my-replication-alias',
                      ],
                    ],
                  },
                },
              },
            }),
            Match.objectLike({
              'Region': pipelineRegion,
            }),
          ],
        });

        Template.fromStack(replicationStack).hasResourceProperties('AWS::KMS::Key', {
          'KeyPolicy': {
            'Statement': Match.arrayWith([
              {
                // KMS verifies whether the principal given in its key policy exists when creating that key.
                // Since the replication bucket must be deployed before the pipeline,
                // we cannot put the pipeline role as the principal here -
                // hence, we put the account itself
                'Action': [
                  'kms:Decrypt',
                  'kms:DescribeKey',
                  'kms:Encrypt',
                  'kms:ReEncrypt*',
                  'kms:GenerateDataKey*',
                ],
                'Effect': 'Allow',
                'Principal': {
                  'AWS': {
                    'Fn::Join': ['', [
                      'arn:',
                      { 'Ref': 'AWS::Partition' },
                      ':iam::123456789012:root',
                    ]],
                  },
                },
                'Resource': '*',
              },
            ]),
          },
        });


      });

      test('generates ArtifactStores with the alias ARN as the KeyID', () => {
        const app = new cdk.App();
        const replicationRegion = 'us-west-1';

        const pipelineRegion = 'us-west-2';
        const pipelineStack = new cdk.Stack(app, 'MyStack', {
          env: { region: pipelineRegion, account: '123456789012' },
        });
        const sourceOutput = new codepipeline.Artifact();
        const pipeline = new codepipeline.Pipeline(pipelineStack, 'Pipeline', {
          stages: [
            {
              stageName: 'Source',
              actions: [new FakeSourceAction({
                actionName: 'Source',
                output: sourceOutput,
              })],
            },
            {
              stageName: 'Build',
              actions: [new FakeBuildAction({
                actionName: 'Build',
                input: sourceOutput,
                region: replicationRegion,
              })],
            },
          ],
        });

        Template.fromStack(pipelineStack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
          'ArtifactStores': [
            Match.objectLike({
              'Region': replicationRegion,
              'ArtifactStore': {
                'Type': 'S3',
                'EncryptionKey': {
                  'Type': 'KMS',
                  'Id': {
                    'Fn::Join': [
                      '',
                      [
                        'arn:',
                        {
                          'Ref': 'AWS::Partition',
                        },
                        ':kms:us-west-1:123456789012:alias/s-west-1tencryptionalias9b344b2b8e6825cb1f7d',
                      ],
                    ],
                  },
                },
              },
            }),
            Match.objectLike({
              'Region': pipelineRegion,
            }),
          ],
        });

        Template.fromStack(pipeline.crossRegionSupport[replicationRegion].stack).hasResource('AWS::KMS::Alias', {
          'DeletionPolicy': 'Delete',
          'UpdateReplacePolicy': 'Delete',
        });


      });

      test('allows passing an imported Bucket and Key for the replication Bucket', () => {
        const replicationRegion = 'us-west-1';

        const pipelineRegion = 'us-west-2';
        const pipelineStack = new cdk.Stack(undefined, undefined, {
          env: { region: pipelineRegion },
        });
        const sourceOutput = new codepipeline.Artifact();
        new codepipeline.Pipeline(pipelineStack, 'Pipeline', {
          crossRegionReplicationBuckets: {
            [replicationRegion]: s3.Bucket.fromBucketAttributes(pipelineStack, 'ReplicationBucket', {
              bucketArn: 'arn:aws:s3:::my-us-west-1-replication-bucket',
              encryptionKey: kms.Key.fromKeyArn(pipelineStack, 'ReplicationKey',
                `arn:aws:kms:${replicationRegion}:123456789012:key/1234-5678-9012`,
              ),
            }),
          },
          stages: [
            {
              stageName: 'Source',
              actions: [new FakeSourceAction({
                actionName: 'Source',
                output: sourceOutput,
              })],
            },
            {
              stageName: 'Build',
              actions: [new FakeBuildAction({
                actionName: 'Build',
                input: sourceOutput,
              })],
            },
          ],
        });

        Template.fromStack(pipelineStack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
          'ArtifactStores': [
            Match.objectLike({
              'Region': replicationRegion,
              'ArtifactStore': {
                'Type': 'S3',
                'Location': 'my-us-west-1-replication-bucket',
                'EncryptionKey': {
                  'Type': 'KMS',
                  'Id': 'arn:aws:kms:us-west-1:123456789012:key/1234-5678-9012',
                },
              },
            }),
            Match.objectLike({
              'Region': pipelineRegion,
            }),
          ],
        });


      });

      test('generates the support stack containing the replication Bucket without the need to bootstrap in that environment', () => {
        const app = new cdk.App({
          treeMetadata: false, // we can't set the context otherwise, because App will have a child
        });
        app.node.setContext(cxapi.NEW_STYLE_STACK_SYNTHESIS_CONTEXT, true);

        const pipelineStack = new cdk.Stack(app, 'PipelineStack', {
          env: { region: 'us-west-2', account: '123456789012' },
        });
        const sourceOutput = new codepipeline.Artifact();
        new codepipeline.Pipeline(pipelineStack, 'Pipeline', {
          stages: [
            {
              stageName: 'Source',
              actions: [new FakeSourceAction({
                actionName: 'Source',
                output: sourceOutput,
              })],
            },
            {
              stageName: 'Build',
              actions: [new FakeBuildAction({
                actionName: 'Build',
                input: sourceOutput,
                region: 'eu-south-1',
              })],
            },
          ],
        });

        const assembly = app.synth();
        const supportStackArtifact = assembly.getStackByName('PipelineStack-support-eu-south-1');
        expect(supportStackArtifact.assumeRoleArn).toEqual(
          'arn:${AWS::Partition}:iam::123456789012:role/cdk-hnb659fds-deploy-role-123456789012-us-west-2');
        expect(supportStackArtifact.cloudFormationExecutionRoleArn).toEqual(
          'arn:${AWS::Partition}:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-123456789012-us-west-2');


      });
    });

    describe('that is cross-account', () => {
      test('does not allow passing a dynamic value in the Action account property', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'PipelineStack', { env: { account: '123456789012' } });
        const sourceOutput = new codepipeline.Artifact();
        const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
          stages: [
            {
              stageName: 'Source',
              actions: [new FakeSourceAction({ actionName: 'Source', output: sourceOutput })],
            },
          ],
        });
        const buildStage = pipeline.addStage({ stageName: 'Build' });

        expect(() => {
          buildStage.addAction(new FakeBuildAction({
            actionName: 'FakeBuild',
            input: sourceOutput,
            account: cdk.Aws.ACCOUNT_ID,
          }));
        }).toThrow(/The 'account' property must be a concrete value \(action: 'FakeBuild'\)/);


      });

      test('does not allow an env-agnostic Pipeline Stack if an Action account has been provided', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'PipelineStack');
        const sourceOutput = new codepipeline.Artifact();
        const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
          stages: [
            {
              stageName: 'Source',
              actions: [new FakeSourceAction({ actionName: 'Source', output: sourceOutput })],
            },
          ],
        });
        const buildStage = pipeline.addStage({ stageName: 'Build' });

        expect(() => {
          buildStage.addAction(new FakeBuildAction({
            actionName: 'FakeBuild',
            input: sourceOutput,
            account: '123456789012',
          }));
        }).toThrow(/Pipeline stack which uses cross-environment actions must have an explicitly set account/);


      });

      test('does not allow enabling key rotation if cross account keys have been disabled', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'PipelineStack');

        expect(() => {
          new codepipeline.Pipeline(stack, 'Pipeline', {
            crossAccountKeys: false,
            enableKeyRotation: true,
          });
        }).toThrow("Setting 'enableKeyRotation' to true also requires 'crossAccountKeys' to be enabled");
      });

      test("enabling key rotation sets 'EnableKeyRotation' to 'true' in the main generated KMS key", () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'PipelineStack');
        const sourceOutput = new codepipeline.Artifact();
        new codepipeline.Pipeline(stack, 'Pipeline', {
          enableKeyRotation: true,
          stages: [
            {
              stageName: 'Source',
              actions: [new FakeSourceAction({ actionName: 'Source', output: sourceOutput })],
            },
            {
              stageName: 'Build',
              actions: [new FakeBuildAction({ actionName: 'Build', input: sourceOutput })],
            },
          ],
        });

        Template.fromStack(stack).hasResourceProperties('AWS::KMS::Key', {
          'EnableKeyRotation': true,
        });
      });
    });
  });
});

describe('test with shared setup', () => {
  let stack: cdk.Stack;
  let sourceArtifact: codepipeline.Artifact;
  beforeEach(() => {
    stack = new cdk.Stack();
    sourceArtifact = new codepipeline.Artifact();
  });

  test('can add actions to stages after creation', () => {
    // GIVEN
    const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
      stages: [
        {
          stageName: 'Source',
          actions: [new FakeSourceAction({ actionName: 'Fetch', output: sourceArtifact })],
        },
        {
          stageName: 'Build',
          actions: [new FakeBuildAction({ actionName: 'Gcc', input: sourceArtifact })],
        },
      ],
    });

    // WHEN
    pipeline.stage('Build').addAction(new FakeBuildAction({ actionName: 'debug.com', input: sourceArtifact }));

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([{
        Name: 'Build',
        Actions: [
          Match.objectLike({ Name: 'Gcc' }),
          Match.objectLike({ Name: 'debug.com' }),
        ],
      }]),
    });
  });
});
