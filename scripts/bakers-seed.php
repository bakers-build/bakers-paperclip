<?php
// Seeds the local bakers.build (docker compose --profile bakers) for the e2e tests and the demo:
// group Demo (DEMO Shop, DEMO2 Blog, team, conductor on DEMO), group "Other customer" (FOREIGN),
// Rita Requester and Devon Developer, the PM agent's service account, a member of the Demo
// team only, and the Demo group's webhook to the bridge. Idempotent; prints
// BAKERS_E2E_WEBHOOK_SECRET=<the webhook's secret> and BAKERS_E2E_API_KEY=<a new key>.
$etm = \Drupal::entityTypeManager();
$one = fn (string $type, array $props) => current($etm->getStorage($type)->loadByProperties($props)) ?: NULL;
$make = function (string $type, array $values) use ($etm) {
  $entity = $etm->getStorage($type)->create($values);
  $entity->save();
  return $entity;
};
$get = fn (string $type, array $props, array $more = []) => $one($type, $props) ?: $make($type, $props + $more);

$admin = \Drupal\user\Entity\User::load(1);
$ws = current($etm->getStorage('bb_workspace')->loadMultiple());
$writer = \Drupal::service('bb_core.membership_writer');
// A member with a rank: a Guest has no access to the team's projects (a conductor's owner needs it).
$member = function ($group, $user, string $role) use ($writer) {
  if (!$writer->membershipOf($group, (int) $user->id())) {
    $writer->add($group, $user->id());
  }
  $writer->writeRole($group, (int) $user->id(), $role, \Drupal\bb_core\Members\MemberItemBuilder::assignableRoles($group));
};

$demo = $get('bb_group', ['name' => 'Demo', 'workspace_id' => $ws->id()]);
$other = $get('bb_group', ['name' => 'Other customer', 'workspace_id' => $ws->id()]);
$team = $get('bb_team', ['name' => 'Demo team', 'workspace_id' => $ws->id()]);
$otherTeam = $get('bb_team', ['name' => 'Other team', 'workspace_id' => $ws->id()]);

$user = fn (string $mail, string $name) => $one('user', ['mail' => $mail]) ?: $make('user', ['name' => $name, 'mail' => $mail, 'status' => 1]);
$rita = $user('requester@example.org', 'Rita Requester');
$devon = $user('developer@example.org', 'Devon Developer');
foreach ([$rita, $devon] as $u) {
  $member($ws, $u, 'contributor');
  $member($team, $u, 'member');
}

$project = fn (string $key, string $name, string $description, $group, $t) => $one('bb_project', ['key' => $key])
  ?: $make('bb_project', ['key' => $key, 'name' => $name, 'description' => $description, 'group_id' => $group->id(), 'teams' => [$t->id()], 'owner_user_id' => $devon->id(), 'next_number' => 1]);
$shop = $project('DEMO', 'Demo Shop', 'The online shop: catalogue, cart and checkout.', $demo, $team);
$project('DEMO2', 'Demo Blog', 'The company blog and its newsletter sign-up.', $demo, $team);
$project('FOREIGN', 'Another customer', 'A project of another group.', $other, $otherTeam);

$machine = $get('bb_machine', ['host_key' => 'paperclip-e2e'], ['name' => 'paperclip-e2e', 'max_parallel' => 1, 'current_load' => 0, 'owner_user_id' => $devon->id(), 'assignment' => 'allow']);
$get('bb_conductor', ['conductor_id' => 'paperclip-e2e-demo'], ['label' => 'paperclip-e2e · Demo Shop', 'status' => 'online', 'active' => TRUE, 'project_id' => $shop->id(), 'owner_user_id' => $devon->id(), 'machine' => $machine->id()]);

// The Demo group's webhook, as README › Set up a group step 7 creates it on the group's Webhooks
// tab. Saved without the form's validation: its https-only rule would refuse the bridge's address
// inside the compose network.
$webhook = $get('bb_webhook', ['name' => 'Paperclip', 'group_id' => $demo->id()], [
  'workspace_id' => $ws->id(),
  'url' => 'http://paperclip:3100/api/plugins/bakers-bridge/webhooks/bakers',
  'enabled' => TRUE,
  'owner_user_id' => $admin->id(),
]);
echo "BAKERS_E2E_WEBHOOK_SECRET={$webhook->getSecret()}\n";

$accounts = \Drupal::service('bb_api_key.service_account_manager');
$expiry = date('Y-m-d', strtotime('+1 year'));
$sa = $one('user', ['name' => 'PM Agent E2E']);
$issued = $sa
  ? $accounts->issueKey($sa, $expiry, $admin, 'paperclip e2e')
  : $accounts->create($ws, $team, 'PM Agent E2E', 'contributor', 'member', $expiry, $admin, 'paperclip e2e');
// bakers.build's /mcp takes the key as `Bearer <client_id>:<secret>`.
echo "BAKERS_E2E_API_KEY={$issued['consumer']->get('client_id')->value}:{$issued['secret']}\n";
