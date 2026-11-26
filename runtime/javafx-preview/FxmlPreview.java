import javafx.application.Platform;
import javafx.fxml.FXMLLoader;
import javafx.scene.Group;
import javafx.scene.Node;
import javafx.scene.Parent;
import javafx.scene.Scene;
import javafx.scene.image.PixelFormat;
import javafx.scene.image.WritableImage;
import javafx.scene.paint.Color;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;

class FxmlPreview {
    public static void main(String[] args) throws Exception {
        Path file = Path.of(args[0]), output = Path.of(args[1]);
        int width = dimension(args[2]), height = dimension(args[3]);
        CompletableFuture<Void> rendered = new CompletableFuture<>();
        Platform.startup(() -> {});
        Platform.runLater(() -> {
            try {
                FXMLLoader loader = new FXMLLoader(file.toUri().toURL());
                loader.setControllerFactory(type -> {
                    throw new IllegalArgumentException("User controllers are outside the FXML preview.");
                });
                Object loaded = loader.load();
                if (!(loaded instanceof Node node)) throw new IllegalArgumentException("FXML preview requires a JavaFX node.");
                Parent root = node instanceof Parent parent ? parent : new Group(node);
                Scene scene = new Scene(root, width, height, Color.WHITE);
                root.applyCss();
                root.layout();
                WritableImage snapshot = scene.snapshot(null);
                int[] pixels = new int[width * height];
                snapshot.getPixelReader().getPixels(0, 0, width, height, PixelFormat.getIntArgbInstance(), pixels, 0, width);
                BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
                image.setRGB(0, 0, width, height, pixels, 0, width);
                try (var stream = Files.newOutputStream(output, StandardOpenOption.CREATE_NEW)) {
                    if (!ImageIO.write(image, "png", stream)) throw new IllegalStateException("PNG output is unavailable.");
                }
                rendered.complete(null);
            } catch (Throwable problem) {
                rendered.completeExceptionally(problem);
            }
        });
        try {
            rendered.get(25, TimeUnit.SECONDS);
            System.out.println("Rocketbrain FXML Preview " + System.getProperty("javafx.runtime.version"));
        } finally {
            Platform.exit();
        }
    }

    private static int dimension(String value) {
        int result = Integer.parseInt(value);
        if (result < 32 || result > 1024) throw new IllegalArgumentException("Invalid FXML preview dimensions.");
        return result;
    }
}
