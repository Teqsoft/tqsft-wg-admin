#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TqsftWgAdminStack } from '../lib/tqsft-wg-admin-stack';

const app = new cdk.App();
new TqsftWgAdminStack(app, 'TqsftWgAdminStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});