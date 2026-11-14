class RotationApply {
  public status: { running: boolean } = { running: false };

  /** Background: syncHubVisibility + syncUnifiedOrdering, then markApplied. Skips while a sync runs. */
  public kick(): void {
    throw new Error('not implemented');
  }
}

export const rotationApply = new RotationApply();
export default rotationApply;
