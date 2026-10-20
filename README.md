# Havbruksloggen Autofyll 🐟

A Tampermonkey userscript that helps fill repetitive fields in [Havbruksloggen](https://havbruksloggen.no/), including washing information, comments, and inspection checklists.

> **Status:** v3.1 Beta 2 — in everyday testing. This is an independent, unofficial tool, not affiliated with Havbruksloggen.

## Features

- **Autofill across form pages:** remembers commonly used values such as responsible person and fills supported fields when they appear.
- **Washing comments:** builds a comment from selected **Top**, **Side**, **Bunn**, **Etterkontroll**, and **Inspeksjon** options. **Luseskjørt** does not appear in the generated washing comment.
- **Checklist modes:**
  - **Etterkontroll:** fills only *ROV kontrollert før utsett i not*.
  - **Inspeksjon:** fills the standard inspection points except the four luseskjørt points.
  - **Luseskjørt:** fills the four luseskjørt points.
  - Modes can be combined.
- **Adaptive sjekkpunkter:** recognizes known questions by their text rather than relying solely on fixed IDs. Unknown questions require review and approval before autofill.
- **Green-answer detection:** uses the question's green-marked answer instead of assuming every answer should be “Ja” or “Ok”.
- **Manual-edit protection:** does not intentionally overwrite answers changed by the user.
- **AJAX handling and retries:** waits for delayed fields and handles asynchronous page updates.
- **Status and warnings:** reports incomplete or changed checklist items without submitting the form.
- **Backup tools:** export/import learned checklist rules and the reference in **Avansert → Adaptive sjekkpunkter**.
- **Built-in simulations:** tests inserted, changed, and removed checklist questions without changing the live form.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the latest script file from this repository (for example, `Havbruksloggen_Autofyll_v3.1_Beta2.user.js`).
3. Create a new script in Tampermonkey, replace the template with the full script, and save.
4. Open `https://havbruksloggen.no/` and configure the autofill menu.
5. Review the filled values before proceeding with your report.

**Important:** Disable older versions of the script in Tampermonkey to avoid conflicts. You can keep v3.0 RC4 installed but disabled as a backup.

## How to use

1. Open a supported Havbruksloggen form.
2. Set your responsible person and other defaults in the floating autofill menu.
3. Choose the relevant washing and checklist modes.
4. Let the script fill the fields, including those loaded after an AJAX update.
5. Check the results and adjust anything manually as needed.

The script **does not automatically submit reports**.

### When a checklist changes

If Havbruksloggen adds or changes a question, open **Avansert → Adaptive sjekkpunkter**. Review the question text and the detected green answer before assigning a category and approving it. Do not approve a question unless you have verified what it means. Changed or missing known questions may pause checklist autofill until reviewed.

## Testing status

The following behavior has been checked during development:

| Test | Result |
| --- | --- |
| Autofill of the 20 existing checklist questions | Passed on the live form |
| Simulation: new question inserted at the top | Passed |
| Simulation: existing question changed | Passed |
| Simulation: existing question removed | Passed |
| Manual answer remains unchanged | Passed |
| Dynamic **Avvik** fields do not cause false question-change warnings | Passed after Beta 2 fix |

**Not yet fully verified:** the end-to-end approval and autofill of a genuinely new question on the live site, and all possible network/AJAX failure scenarios. Simulations are not a substitute for live testing.

## Safety and limitations

- This is a convenience tool, **not a substitute for performing inspections or checking the report**.
- Always verify autofilled answers against the actual conditions before submitting.
- A website redesign, changed wording, or altered answer styling may require an update.
- Unknown questions should remain unanswered until explicitly reviewed.
- Settings and learned rules are stored locally in the browser; export a backup before reinstalling or switching computers.

## Troubleshooting

**A field does not fill:** wait for the page to finish loading, then check the script's status and warnings. Some fields appear later than others.

**A checklist warning appears:** open **Avansert → Adaptive sjekkpunkter** to see whether a question is missing, changed, or unknown.

**Two floating buttons appear:** ensure that only one version of the userscript is enabled.

**Manual edits are overwritten or errors repeat:** record the page, affected question, and exact warning message before reporting the issue. Avoid including personal or operationally sensitive information in public GitHub issues.

## Version history

- **v3.1 Beta 2:** fixes false question-change warnings caused by dynamically displayed **Avvik** fields.
- **v3.1 Beta:** introduces text-based checklist identification, green-answer detection, and adaptive question review.
- **v3.0 RC4:** previous working baseline for form autofill and checklist behavior.

## Disclaimer

Unofficial community/personal automation project. Use at your own discretion and in accordance with your workplace procedures and the website's terms. You remain responsible for reviewing and submitting accurate information.
