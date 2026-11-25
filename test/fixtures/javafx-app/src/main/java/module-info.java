module dev.rocketbrain.fxml {
    requires javafx.graphics;
    requires javafx.fxml;
    opens dev.rocketbrain.fxml to javafx.fxml;
    exports dev.rocketbrain.fxml;
}
