package wildflyfixture;

import jakarta.ejb.EJB;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

@WebServlet("/ping")
public class InventoryServlet extends HttpServlet {
    @EJB
    private InventoryBean inventory;

    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String rows = inventory.counts();
        response.setContentType("text/plain");
        response.getWriter().write("EJB:" + request.getContextPath() + ":" + rows);
    }
}
