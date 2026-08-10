import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function compileWorld(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Compile world' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm compile' });
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Confirm & compile' }).click();
  await expect(page.getByRole('button', { name: 'Save patch' })).toBeVisible();
}

test('loads the visual editor and reference world', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'WORLD DIRECTION' })).toContainText('temperate coastal valley');
  await expect(page.getByLabel('3D world viewport')).toBeVisible();
  await expect(page.getByText('256 / 256 chunks')).toBeVisible();
  await expect(page.getByText('World specification')).toBeVisible();
  await expect(page.getByText('Chunk inspector')).toBeVisible();
  await expect(page.getByLabel('Inspected chunk')).toHaveValue(/^-?\d+:-?\d+$/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Compile world' })).toBeEnabled();
});

test('supports an explicit WebGL2 conformance backend', async ({ page }) => {
  await page.goto('/?renderer=webgl2');
  await expect(page.getByText('WEBGL2')).toBeVisible();
  await expect(page.getByLabel('Inspected chunk')).toHaveValue(/^-?\d+:-?\d+$/, { timeout: 15_000 });
});

test('authors visual changes with reversible brushes and environment controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Inspected chunk')).toHaveValue(/^-?\d+:-?\d+$/, { timeout: 15_000 });
  await page.getByRole('button', { name: 'terrain' }).click();
  await page.getByRole('button', { name: /center fallback/ }).click();
  await expect(page.getByText('REV 1')).toBeVisible();
  await expect(page.getByRole('button', { name: /Undo/ })).toBeEnabled();
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(page.getByText('REV 0')).toBeVisible();

  await page.getByRole('button', { name: 'region', exact: true }).click();
  await page.getByRole('button', { name: /paint \+5%/ }).click();
  await expect(page.getByText('REV 1')).toBeVisible();
  await page.getByLabel('Weather').selectOption('rain');
  await expect(page.getByText('REV 2')).toBeVisible();
  await page.getByRole('button', { name: 'Snapshot' }).click();
  await expect(page.getByText('2 snapshots')).toBeVisible();
});

test('requires explicit compile confirmation and records the local compile', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compile world' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm compile' })).toBeVisible();
  await expect(page.getByText('Maximum cost').locator('..')).toContainText('$0.00');
  await page.getByRole('dialog', { name: 'Confirm compile' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Confirm & compile' }).click();
  await expect(page.getByRole('button', { name: 'Compile world' })).toBeEnabled();
  await page.getByRole('button', { name: /Diagnostics/ }).click();
  await expect(page.getByText('compile · completed')).toBeVisible();
});

test('exposes fail-closed server-side BYOK status and responsive keyboard navigation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Pipeline' }).click();
  await expect(page.getByText('SERVER-SIDE BYOK')).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Local / })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Cheap / })).toBeDisabled();
  await expect(page.getByText('POLICY REVIEW').first()).toBeVisible();
  await expect(page.getByText('Keys never enter this browser or an exported game. Configure them on the compiler service with reviewed provider policies.')).toBeVisible();

  // Navigation is intentionally available without a prior canvas click; form fields remain guarded.
  await expect(page.getByLabel('Inspected chunk')).toHaveValue(/^-?\d+:-?\d+$/);
  const navigation = page.getByLabel('Camera focus coordinates');
  const home = await navigation.textContent();
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.up('w');
  await expect(navigation).not.toHaveText(home!);
  await page.keyboard.press('r');
  await expect(navigation).toHaveText(home!);
});

test('loads canonical compiler artifacts and persists a revisioned editor patch', async ({ page }) => {
  await page.goto('/');
  await compileWorld(page);
  await page.getByRole('button', { name: 'terrain' }).click();
  await page.getByRole('button', { name: /center fallback/ }).click();
  await page.getByRole('button', { name: 'Save patch' }).click();
  await page.getByRole('button', { name: /Diagnostics/ }).click();
  await expect(page.getByText(/Saved 0 asset imports and patch editor-/)).toBeVisible();
});

test('regenerates one region through a canonical revisioned patch', async ({ page }) => {
  await page.goto('/');
  await compileWorld(page);

  await page.getByRole('button', { name: 'Regenerate region…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Regenerate / });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Regional visual direction' }).fill('A dense frozen forest with wind-shaped snow and ice');
  await dialog.getByRole('button', { name: 'Apply regeneration' }).click();
  await expect(dialog).not.toBeVisible();

  await expect(page.getByText('frozen-tundra')).toBeVisible();
  await page.getByRole('button', { name: /Diagnostics/ }).click();
  await expect(page.getByText(/schema-valid regional prompt/)).toBeVisible();
  await expect(page.getByText('regenerate · completed')).toBeVisible();
});

test('requires rights affirmation before staging an imported GLB', async ({ page }) => {
  await page.goto('/');
  await compileWorld(page);
  await page.getByRole('button', { name: 'Assets' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.asset-grid button').first().click();
  const fileChooser = await chooser;
  await fileChooser.setFiles({ name: 'reviewed.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('not-uploaded-before-confirmation') });
  const dialog = page.getByRole('dialog', { name: 'Review imported GLB' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Stage reviewed asset' })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await expect(dialog.getByRole('button', { name: 'Stage reviewed asset' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
});
