package dev.rocketbrain.fxml;

import javafx.fxml.FXMLLoader;
import javafx.scene.Group;

public class App {
    public static void main(String[] args) throws Exception {
        FXMLLoader loader = new FXMLLoader(App.class.getResource("/views/panel.fxml"));
        Group root = loader.load();
        Panel panel = loader.getController();
        String execution = panel.inspect();
        if (!execution.equals("detail:extra:1") || root.getStylesheets().size() != 1 || root.getChildren().size() != 2) {
            throw new IllegalStateException("FXML runtime did not load the inspected design: " + execution);
        }
        System.out.println("ROCKETBRAIN_FXML_OK:" + execution);
    }
}
