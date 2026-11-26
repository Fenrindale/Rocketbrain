package earfixture;

import jakarta.ejb.Local;
import java.io.IOException;

@Local
public interface InventoryLocal {
    String counts() throws IOException;
}
