package dev.rocketbrain.fxml;

import javafx.fxml.FXML;
import javafx.scene.Group;

public class Panel {
    @FXML private Group detail;
    @FXML private Group extra;
    private int clicks;

    @FXML
    private void recordClick() {
        clicks++;
    }

    public String inspect() {
        detail.getOnMouseClicked().handle(null);
        return detail.getId() + ":" + extra.getId() + ":" + clicks;
    }
}
