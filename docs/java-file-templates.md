# Java file templates and copyright profiles

Run **Rocketbrain: New Java File from Template** and choose a source root, a template, a Java type name and a package. The source-root picker identifies Maven, Gradle and standalone Java roots. Templates and copyright profiles can apply to all source roots or to selected tools and main or test roots. The command creates an ordinary new file, opens it in the editor and refuses an existing destination.

Set **Rocketbrain › Java: File Templates** to add named templates. Each template body accepts `${name}`, `${package}` and `${packageDeclaration}`. Declare **variables** for any `${variable.example}` placeholders. The picker prompts for each variable, with its configured default when present. An **identifier** is inserted as a Java identifier, a **string** is inserted as a complete quoted Java literal and an **integer** is inserted as a 32-bit decimal literal.

Set **Rocketbrain › Java: Copyright Profiles** to add names and plain-text notices. The notice accepts `${year}`, `${name}` and `${package}`. Rocketbrain adds the selected notice as line comments at the top of the new file. **Default Copyright Profile** puts a compatible profile first in the picker. Select **No copyright header** to create the template without an added notice.

Here is a settings example for a Gradle production class with one prompted label and a matching header.

```json
{
  "rocketbrain.java.fileTemplates": [
    {
      "name": "Named Gradle component",
      "source": "main",
      "buildTools": ["gradle"],
      "variables": [
        { "name": "label", "kind": "string", "prompt": "Component label", "default": "Main" }
      ],
      "template": "${packageDeclaration}public class ${name} {\n    public static final String LABEL = ${variable.label};\n}\n"
    }
  ],
  "rocketbrain.java.copyrightProfiles": [
    {
      "name": "Project notice",
      "buildTools": ["gradle"],
      "notice": "Copyright ${year} Example Project\nGenerated for ${package}.${name}"
    }
  ],
  "rocketbrain.java.defaultCopyrightProfile": "Project notice"
}
```
