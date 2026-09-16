# UI approval

For changes to rendered UI, both the Astra implementation owner and the exact Fable 5.1 High reviewer must inspect actual rendered screenshots before approval. Source review and automated overflow checks alone do not satisfy this requirement.

- Capture desktop and narrow mobile views of every changed surface, including relevant expanded, error, disabled and focus states.
- Check typography, hierarchy, spacing, wrapping, contrast, actionable labels, clipping and overlap. Exercise the controls and inspect console errors.
- Give Fable access to the actual image files and verify that it viewed them. If either reviewer cannot view the images, visual approval is blocked.
- Record the image paths, reviewed states and each reviewer's verdict in the owning task's evidence. Keep temporary screenshots and scripts outside the repository.
- Obtain final approval of the actual diff and rendered result before a user-authorized commit or push. A previous UI approval does not cover later UI changes.

For onboarding or setup changes, demonstrate the full fresh-user journey through visible UI and shipped commands. Account for every input, automate needless public-data gathering, and explain disabled controls with a next action. Keep docs concise and command-first. Require separate technical and UX acceptance verdicts; technical approval cannot override a UX blocker.
