# Build a modular JavaFX Gradle image

Run **Run or Package JavaFX Application**, choose the local Gradle application, and select **Build JavaFX runtime image**. The action imports the application into Java Projects when needed, discovers its qualified `:jlink` task, and uses the reviewed build task runner. Configure an independent Gradle distribution and JDK through the Java workbench.

The supported project uses the OpenJFX and Badass JLink plugins with a JavaFX module descriptor at `src/main/java/module-info.java`. The plugin's image and intermediate directories must be separate physical paths below the project's `build` directory. A custom local image name and a single configured launcher are supported.

After a successful build, Rocketbrain checks the runtime's module list and module payload and reports the generated launcher. **Reveal Image** opens the image directory. Launch the image separately when ready. On Windows, the reported launcher is its `.bat` file.

The Gradle action covers local, single-platform runtime images. The Maven action continues to use the JavaFX Maven plugin.

See the [OpenJFX Gradle and jlink workflow](https://openjfx.io/openjfx-docs/) and the [Badass JLink task output contract](https://github.com/beryx/badass-jlink-plugin/blob/v4.2.0/src/main/groovy/org/beryx/jlink/JlinkTask.groovy).
