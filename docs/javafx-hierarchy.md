# Edit the FXML scene hierarchy

Save the FXML file and open **Preview JavaFX FXML**. Under **Scene containers**, choose a layout container. Add a built-in node, reorder adjacent children, or remove a built-in leaf without controller or event wiring. The preview shows the original and proposed layouts using OpenJFX.

Choose **Apply to FXML Editor**, then save the file. The edit is part of the editor's undo history. Changes to the FXML or its linked stylesheets and includes require a fresh preview.

The hierarchy editor supports static built-in layout containers on Windows x64, with direct children or an explicit `<children>` element. Comments or property elements between two children limit reordering. The preview leaves controller and event hookups untouched in the source. [OpenJFX FXML reference](https://openjfx.io/javadoc/26/javafx.fxml/javafx/fxml/doc-files/introduction_to_fxml.html)
