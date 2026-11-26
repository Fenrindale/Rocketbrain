package earfixture.web;

import earfixture.InventoryLocal;
import jakarta.ejb.EJB;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

@WebServlet("/ping")
public class InventoryServlet extends HttpServlet {
    @EJB
    private InventoryLocal inventory;

    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String rows = inventory.counts();
        boolean separateWebModule = InventoryServlet.class.getClassLoader() != InventoryLocal.class.getClassLoader();
        response.setContentType("text/plain");
        response.getWriter().write("EAR:" + request.getContextPath() + ":" + rows + ":" + separateWebModule);
    }
}
