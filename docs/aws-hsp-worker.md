# Vikings HSP worker operations

Account: `631285163809` (`--profile vikings`). Region: `ap-south-1` (Mumbai).
Infrastructure files in `infra/aws/` are intentionally untracked; do not stage/commit them without new instructions.

## Persistent network

CloudFormation stack `horizon-vikings-network` owns a dedicated VPC, public NAT gateway and
private worker subnet. The network stack has termination protection. The Elastic IP has
`DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`.

- Public egress IPv4: `13.205.56.13`
- Allocation: `eipalloc-003f468028c559593`
- NAT: `nat-0e494f6474f6bf368`
- VPC: `vpc-0afd01b9ae8f40e5b`
- Worker subnet: `subnet-0af3f997cf2f3a17b`

Stop/replace compute independently of this stack. Never release the EIP to save compute costs.
If the NAT must be rebuilt, reuse this allocation and wait for the NAT/route to become ready.
Retaining the EIP alone does not retain routing; retain the network stack for uninterrupted egress.

## Worker

`horizon-vikings-worker` owns a `t3.small` Amazon Linux 2023 x86_64 instance with 16 GiB
encrypted gp3 root storage, IMDSv2 required, standard CPU credits, no public IP and no inbound
security-group rules. Only outbound HTTPS and VPC DNS are allowed. Its instance role is limited
to AWS's SSM managed instance policy. No access keys or wallet sessions are in user-data.

Instance: `i-0d238e893179dbabc` (private IPv4 `10.78.1.187`). SSM reports Online.
Bootstrap completed successfully and an SSM Run Command verified egress `13.205.56.13`.

Find the instance:

```sh
aws cloudformation describe-stacks --stack-name horizon-vikings-worker \
  --profile vikings --region ap-south-1 \
  --query 'Stacks[0].Outputs' --output table
```

Use its InstanceId with `aws ssm start-session --target INSTANCE_ID --profile vikings --region ap-south-1`.
The local Session Manager plugin is required for interactive sessions. Run Command can also execute
bounded administrative commands. No SSH key or public port is needed.

Stop compute using `aws ec2 stop-instances --instance-ids INSTANCE_ID --profile vikings --region ap-south-1`;
restart using `start-instances`. For replacement, delete/recreate **only the worker stack** with the
existing VPC/subnet parameters. Export required app/journal data before replacement; the root disk
is deleted with the instance. Reauthenticate OKX on a replacement rather than baking wallet sessions
into an image. Never delete the network stack during routine compute replacement.

## HSP access

The client must execute on this worker, or use an authenticated tunnel into it. Calling HSP directly
from the Mac does not use the whitelisted AWS IP. Confirm actual worker egress:

```sh
curl --fail --silent --show-error https://api.ipify.org
```

Form: https://docs.google.com/forms/d/e/1FAIpQLScPgTst1_F8mBFrIo1M3tuXkkVODpVyrfc3i-KsXovHFt7Vcg/viewform

Submission status: Submit was clicked once with the verified egress IP. Google Forms navigated
to `formResponse`, but the confirmation page remained blank; receipt is unverified. No duplicate
submission was attempted. HSP allowlisting is still pending.

Team and HSP `merchant_name`: **Vikings**; contact **akash.jsmith@gmail.com**;
environment **Cloud server**. Wait for HSP Operations confirmation before connecting to
`https://mcp-qa.hashkeymerchant.com/`. HSP centrally manages its App Key/App Secret for this
hackathon; general merchant API credentials are a separate flow.

After confirmation, check health once, discover the eight required MCP tools and call
`get_chain_config`. Health alone is not proof of payment access. Exact token funding,
OKX wallet login and chain-specific signing validation remain separate from infrastructure readiness.

## Costs

AWS Price List queried Nov 2, 2026: Mumbai NAT **$0.056/hour + $0.056/GB processed**;
public IPv4 **$0.005/hour**; Linux t3.small **$0.0224/hour**. At 730 hours/month, NAT+IPv4
is about **$44.53**, and EC2 adds **$16.35**, plus disk, transfer and applicable tax.
Stopping EC2 stops its compute charge, but NAT, IPv4 and disk remain billable.
The account's remaining promotional credit balance is not established by STS or these prices.

Pricing sources: AWS Price List (`AmazonEC2`, Mumbai NAT Gateway and Linux t3.small),
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/ap-south-1/index.json

## Verification boundary

Cloud infrastructure provisioning, actual egress verification, form receipt, whitelist approval,
MCP access, wallet login, funding and payment finalization must be recorded separately.
No wallet signature, approval transaction or payment is authorized by infrastructure setup alone.
